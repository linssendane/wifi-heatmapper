/**
 * /api/settings API
 * GET /api/settings?name=<floorplan-name> - reads settings for a floorplan
 * POST /api/settings - writes settings to a file
 * GET /api/settings?list=true - lists all available survey files
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir, readdir, copyFile } from "fs/promises";
import path from "path";
import { sanitizeFilename } from "@/lib/utils";
import { recordSurveyState } from "@/lib/surveyLedger";

const SURVEYS_DIR = path.join(process.cwd(), "data", "surveys");

/**
 * Get the full path for a survey file
 */
function getSurveyPath(floorplanName: string): string {
  const sanitized = sanitizeFilename(floorplanName);
  return path.join(SURVEYS_DIR, `${sanitized}.json`);
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const listAll = searchParams.get("list");
  const name = searchParams.get("name");

  // List all survey files
  if (listAll === "true") {
    try {
      await mkdir(SURVEYS_DIR, { recursive: true });
      const files = await readdir(SURVEYS_DIR);
      const jsonFiles = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
      return NextResponse.json({ surveys: jsonFiles });
    } catch (err) {
      return NextResponse.json(
        { error: `Unable to list surveys: ${err}` },
        { status: 500 },
      );
    }
  }

  // Read a specific survey file
  if (!name) {
    return NextResponse.json(
      { error: "Missing 'name' query parameter" },
      { status: 400 },
    );
  }

  try {
    const filePath = getSurveyPath(name);
    const data = await readFile(filePath, "utf-8");
    return NextResponse.json(JSON.parse(data));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return NextResponse.json({ error: "Survey not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: `Unable to read survey: ${err}` },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const settings = await request.json();

    if (!settings.floorplanImageName) {
      return NextResponse.json(
        { error: "Missing floorplanImageName in settings" },
        { status: 400 },
      );
    }

    // Ensure surveys directory exists
    await mkdir(SURVEYS_DIR, { recursive: true });

    // Remove sensitive data before saving
    const { sudoerPassword: _, ...safeSettings } = settings;

    const filePath = getSurveyPath(settings.floorplanImageName);

    // Guard against data loss.
    //
    // The client keeps settings in React state and calls updateSettings() ->
    // writeSettingsToFile() on every partial change. On mount that state starts
    // as getDefaults("") with an empty surveyPoints array, and the floorplan is
    // only loaded afterwards by an effect. Any write that lands in that window
    // carries the *previous* floorplanImageName together with *empty* points,
    // which silently truncates a completed survey. Switching floorplans in the
    // media dropdown hits the same race.
    //
    // The client cannot be trusted to have loaded the file it is overwriting,
    // so enforce it here, at the only chokepoint every write passes through.
    const incomingPoints = Array.isArray(safeSettings.surveyPoints)
      ? safeSettings.surveyPoints.length
      : 0;
    let existingPoints = 0;
    try {
      const previous = JSON.parse(await readFile(filePath, "utf-8"));
      existingPoints = Array.isArray(previous.surveyPoints)
        ? previous.surveyPoints.length
        : 0;
    } catch {
      // no existing survey file - nothing to protect
    }

    if (existingPoints > 0 && incomingPoints === 0) {
      return NextResponse.json(
        {
          error:
            `Refusing to overwrite ${existingPoints} recorded survey point(s) ` +
            `with an empty survey. Reload the page and re-select the floorplan.`,
        },
        { status: 409 },
      );
    }

    // Any other shrink is legitimate (deleting a point), but keep a copy anyway.
    if (existingPoints > incomingPoints) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await copyFile(filePath, `${filePath}.${stamp}.bak`);
    }

    await writeFile(filePath, JSON.stringify(safeSettings, null, 2));

    // Append-only mirror. The JSON above is app state the client can clobber;
    // this is the durable record. Never throws - see surveyLedger.
    await recordSurveyState(
      settings.floorplanImageName,
      safeSettings.surveyPoints ?? [],
    );

    return NextResponse.json({ status: "success", path: filePath });
  } catch (err) {
    return NextResponse.json(
      { error: `Unable to save survey: ${err}` },
      { status: 500 },
    );
  }
}

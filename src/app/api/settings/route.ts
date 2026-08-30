/**
 * /api/settings API
 * GET /api/settings?name=<floorplan-name> - reads settings for a floorplan
 * POST /api/settings - writes settings to a file
 * GET /api/settings?list=true - lists all available survey files
 */
import { NextRequest, NextResponse } from "next/server";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  rename,
  unlink,
} from "fs/promises";
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

/**
 * Serialize work per survey file.
 *
 * Saving is a read-compare-write (the guard below inspects what is already on
 * disk before overwriting it), and the client fires settings POSTs constantly.
 * Two overlapping handlers would each read the same "before" state and the
 * later write would silently drop the earlier one's points.
 */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallow rejections on the chain itself so one failure cannot poison the
  // queue for subsequent writers; the real result still propagates to `next`.
  fileLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Write a file atomically: a full write to a sibling temp file, then a rename.
 *
 * fs.writeFile truncates and then streams, so two concurrent writes to one path
 * interleave: the shorter payload lands, the longer one's tail is appended after
 * it, and the file ends with trailing bytes after the closing brace. That is a
 * corrupt survey and an unparseable file. rename(2) is atomic within a
 * filesystem, so a reader sees either the old file or the new one, never a mix.
 */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
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

    return await withFileLock(filePath, async () => {
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

      await writeFileAtomic(filePath, JSON.stringify(safeSettings, null, 2));

      // Append-only mirror. The JSON above is app state the client can clobber;
      // this is the durable record. Never throws - see surveyLedger.
      await recordSurveyState(
        settings.floorplanImageName,
        safeSettings.surveyPoints ?? [],
      );

      return NextResponse.json({ status: "success", path: filePath });
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Unable to save survey: ${err}` },
      { status: 500 },
    );
  }
}

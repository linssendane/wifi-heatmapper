/**
 * wifi-heatmapper file storage
 *
 * Survey data is stored as JSON files in data/surveys/
 * Each floorplan has its own file: data/surveys/<floorplanImageName>.json
 *
 * - readSettingsFromFile(fileName) reads the settings for a floorplan
 *   - Returns null if the file doesn't exist (caller should provide defaults)
 *
 * - writeSettingsToFile(settings) saves settings to a file
 *   - The filename is derived from settings.floorplanImageName
 *   - Sensitive data (sudoerPassword) is stripped before saving
 */

import { HeatmapSettings } from "./types";

export async function readSettingsFromFile(
  fileName: string,
): Promise<HeatmapSettings | null> {
  try {
    if (!fileName) {
      return null;
    }

    const response = await fetch(
      `/api/settings?name=${encodeURIComponent(fileName)}`,
    );

    if (response.status === 404) {
      return null; // Survey doesn't exist yet
    }

    if (!response.ok) {
      // Do NOT return null here. null means "this survey does not exist yet",
      // which licenses the caller to create it from defaults. A failed read
      // tells us nothing about what is on disk, and treating it as absence
      // overwrites a recorded survey with an empty one.
      throw new Error(
        `Failed to read settings for "${fileName}": ${response.status} ${await response.text()}`,
      );
    }

    const parsedData = await response.json();

    // Migration: Earlier versions used iperfResults instead of iperfData
    // Copy iperfResults to iperfData if present
    if (parsedData.surveyPoints?.[0]?.iperfResults !== undefined) {
      for (const point of parsedData.surveyPoints) {
        point.iperfData = point.iperfResults;
        delete point.iperfResults;
      }
    }

    return parsedData;
  } catch (error) {
    // Same reasoning: propagate, never degrade a failure into "absent".
    console.error("Error reading settings:", error);
    throw error;
  }
}

export async function writeSettingsToFile(
  settings: HeatmapSettings,
): Promise<void> {
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      console.error(
        `[wifi-heatmapper] Failed to save settings for "${settings.floorplanImageName}":`,
        response.status,
        response.statusText,
        await response.text(),
      );
    }
  } catch (error) {
    console.error(
      `[wifi-heatmapper] Failed to save settings for "${settings.floorplanImageName}":`,
      error,
    );
  }
}

import { describe, expect, it } from "vitest";
import {
  LOCAL_GEOGON_RELATIVE_PATH,
  LOCAL_GEOGON_RELEASE_AUTHORITY,
  LOCAL_GEOGON_VERSION,
  localGeoGonUrl,
} from "./local-geogon";

describe("bundled GeoGon path", () => {
  it("stays below the current nested PatterDraw route", () => {
    expect(localGeoGonUrl("https://classroom.invalid/math/unit/patterdraw/"))
      .toBe("https://classroom.invalid/math/unit/patterdraw/geogon/index.html?host=patterdraw&patterdraw-geogon=386e47223740ed9955ae1fe8a022516fea98d57f");
  });

  it("keeps the reviewed local version and integration query explicit", () => {
    expect(LOCAL_GEOGON_VERSION).toBe("0.2.10");
    expect(LOCAL_GEOGON_RELEASE_AUTHORITY).toBe("386e47223740ed9955ae1fe8a022516fea98d57f");
    expect(LOCAL_GEOGON_RELATIVE_PATH)
      .toBe("./geogon/index.html?host=patterdraw&patterdraw-geogon=386e47223740ed9955ae1fe8a022516fea98d57f");
  });
});

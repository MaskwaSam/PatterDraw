import { expect, test } from "@playwright/test";

test("fails closed for malformed local asset paths without poisoning Vite", async ({ request }) => {
  for (const assetPath of [
    "/excalidraw-assets/fonts/%ZZ",
    "/pdfjs/standard_fonts/%ZZ",
    "/mathjax/%ZZ",
  ]) {
    const response = await request.get(assetPath);
    expect(response.status(), assetPath).toBe(400);
    expect(await response.text(), assetPath).toBe("Bad Request");
  }

  // The same dev server must remain usable after malformed requests.
  const healthyResponse = await request.get("/");
  expect(healthyResponse.status()).toBe(200);
  expect(await healthyResponse.text()).toContain("PatterDraw");

  const type1FontResponse = await request.get("/pdfjs/standard_fonts/FoxitFixed.pfb");
  expect(type1FontResponse.status()).toBe(200);
  expect(type1FontResponse.headers()["content-type"]).toBe("application/x-font-type1");
});

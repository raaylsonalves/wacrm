import { describe, expect, it } from "vitest";
import {
  getContrastForeground,
  isValidHexColor,
  relativeLuminance,
} from "./color-contrast";

describe("isValidHexColor", () => {
  it("accepts well-formed #rrggbb", () => {
    expect(isValidHexColor("#3b82f6")).toBe(true);
    expect(isValidHexColor("#FFFFFF")).toBe(true);
    expect(isValidHexColor("#000000")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidHexColor("3b82f6")).toBe(false); // missing #
    expect(isValidHexColor("#fff")).toBe(false); // shorthand not supported
    expect(isValidHexColor("#gggggg")).toBe(false); // invalid hex digits
    expect(isValidHexColor("blue")).toBe(false);
    expect(isValidHexColor("")).toBe(false);
  });
});

describe("relativeLuminance", () => {
  it("white is 1, black is 0", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  });

  it("throws on a malformed color", () => {
    expect(() => relativeLuminance("not-a-color")).toThrow();
  });
});

describe("getContrastForeground", () => {
  it("picks black text on light backgrounds", () => {
    expect(getContrastForeground("#ffffff")).toBe("#000000");
    expect(getContrastForeground("#eab308")).toBe("#000000"); // amber theme's yellow
  });

  it("picks white text on dark backgrounds", () => {
    expect(getContrastForeground("#000000")).toBe("#ffffff");
    expect(getContrastForeground("#0f172a")).toBe("#ffffff"); // slate-900
    expect(getContrastForeground("#4c1d95")).toBe("#ffffff"); // violet-900
  });

  it("degrades to white (never throws) on a malformed value", () => {
    expect(getContrastForeground("not-a-color")).toBe("#ffffff");
    expect(getContrastForeground("")).toBe("#ffffff");
  });
});

import { describe, it, expect } from 'bun:test';
import { hsvToRgb, rgbToHsv, rgbToInt, intToRgb } from '../utils/color';

describe('color conversions', () => {
  it('converts primary hues to rgb', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb(120, 1, 1)).toEqual({ r: 0, g: 255, b: 0 });
    expect(hsvToRgb(240, 1, 1)).toEqual({ r: 0, g: 0, b: 255 });
    expect(hsvToRgb(0, 0, 1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(hsvToRgb(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('round-trips rgb -> hsv -> rgb within rounding error', () => {
    const cases = [
      { r: 255, g: 128, b: 0 },
      { r: 12, g: 200, b: 90 },
      { r: 77, g: 77, b: 77 },
      { r: 1, g: 2, b: 3 },
    ];
    for (const rgb of cases) {
      const { h, s, v } = rgbToHsv(rgb);
      const back = hsvToRgb(h, s, v);
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it('handles negative and >360 hues', () => {
    expect(hsvToRgb(360, 1, 1)).toEqual(hsvToRgb(0, 1, 1));
    expect(hsvToRgb(-120, 1, 1)).toEqual(hsvToRgb(240, 1, 1));
  });

  it('packs and unpacks govee color ints', () => {
    expect(rgbToInt({ r: 255, g: 0, b: 0 })).toBe(0xff0000);
    expect(rgbToInt({ r: 1, g: 2, b: 3 })).toBe(0x010203);
    expect(intToRgb(0x010203)).toEqual({ r: 1, g: 2, b: 3 });
    expect(intToRgb(rgbToInt({ r: 40, g: 90, b: 200 }))).toEqual({ r: 40, g: 90, b: 200 });
  });
});

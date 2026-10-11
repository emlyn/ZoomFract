declare module 'spectral.js' {
  export class Color {
    constructor(rgb: number[]);
    readonly XYZ: [number, number, number];
  }
  export function mix(...colours: [Color, number][]): Color;
}

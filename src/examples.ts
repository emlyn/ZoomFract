import fernText from './examples/fern.yaml?raw';
import frameAndRectanglesText from './examples/frame-and-rectangles.yaml?raw';
import pythagorasTreeDensityText from './examples/pythagoras-tree-density.yaml?raw';
import pythagorasTreeText from './examples/pythagoras-tree.yaml?raw';
import rotatedSpiralText from './examples/rotated-spiral.yaml?raw';
import sierpinskiCarpetText from './examples/sierpinski-carpet.yaml?raw';
import sierpinskiText from './examples/sierpinski.yaml?raw';
import twinZoomsText from './examples/twin-zooms.yaml?raw';

export type ExampleDefinition = {
  id: string;
  label: string;
  description: string;
  text: string;
};

export const EXAMPLES: ExampleDefinition[] = [
  {
    id: 'sierpinski',
    label: 'Sierpiński triangle',
    description: 'Three ordered axis-aligned zooms with a black terminal seed.',
    text: sierpinskiText,
  },
  {
    id: 'sierpinski-carpet',
    label: 'Sierpiński Carpet',
    description: 'Eight zooms around an empty centre form a recursive square carpet.',
    text: sierpinskiCarpetText,
  },
  {
    id: 'fern',
    label: 'Fern',
    description: 'Three scaled, rotated zooms aligned to the top of a stem.',
    text: fernText,
  },
  {
    id: 'pythagoras-tree',
    label: 'Pythagoras Tree',
    description: 'Two zooms aligned to a 3-4-5 triangle on top of a square, using variables.',
    text: pythagorasTreeText,
  },
  {
    id: 'pythagoras-tree-density',
    label: 'Pythagoras Tree (density)',
    description: 'The Pythagoras tree shaded by how many copies cover each pixel.',
    text: pythagorasTreeDensityText,
  },
  {
    id: 'rotated-spiral',
    label: 'Rotated spiral',
    description: 'A single rotated zoom with a coloured anchor rectangle.',
    text: rotatedSpiralText,
  },
  {
    id: 'twin-zooms',
    label: 'Twin zooms',
    description: 'Ordered asymmetric zooms with overlapping scene geometry.',
    text: twinZoomsText,
  },
  {
    id: 'frame-and-rectangles',
    label: 'Frame and rectangles',
    description: 'Frame presentation and rectangle constraint examples without recursion.',
    text: frameAndRectanglesText,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export function findExample(id: string): ExampleDefinition | undefined {
  return EXAMPLES.find((example) => example.id === id);
}

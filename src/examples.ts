import { parseScene } from './scene';
import fernText from './examples/fern.yaml?raw';
import pythagorasTreeDensityText from './examples/pythagoras-tree-density.yaml?raw';
import pythagorasTreeInteractiveText from './examples/pythagoras-tree-interactive.yaml?raw';
import pythagorasTreeText from './examples/pythagoras-tree.yaml?raw';
import sierpinskiCarpetText from './examples/sierpinski-carpet.yaml?raw';
import sierpinskiText from './examples/sierpinski.yaml?raw';
import vicsekRedBlueText from './examples/vicsek-red-blue.yaml?raw';

export type ExampleDefinition = {
  id: string;
  label: string;
  description: string;
  text: string;
};

// Names and descriptions come from each definition's `info`, so they are
// written in one place. Built-in examples must have a title.
function example(id: string, text: string): ExampleDefinition {
  const { title, description } = parseScene(text).info;
  if (!title) {
    throw new Error(`Example "${id}" needs an info title`);
  }
  return { id, label: title, description: description ?? '', text };
}

export const EXAMPLES: ExampleDefinition[] = [
  example('sierpinski', sierpinskiText),
  example('sierpinski-carpet', sierpinskiCarpetText),
  example('vicsek-red-blue', vicsekRedBlueText),
  example('fern', fernText),
  example('pythagoras-tree', pythagorasTreeText),
  example('pythagoras-tree-density', pythagorasTreeDensityText),
  example('pythagoras-tree-interactive', pythagorasTreeInteractiveText),
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export function findExample(id: string): ExampleDefinition | undefined {
  return EXAMPLES.find((example) => example.id === id);
}
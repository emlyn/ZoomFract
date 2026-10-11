import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { parseScene } from './scene';

type Path = (string | number)[];
type Fields = Record<string, Field>;
type Field = {
  label?: string;
  initial: unknown;
  fields?: Fields;
  item?: Field;
  choices?: string[];
  multiline?: boolean;
  colour?: boolean;
  variants?: Record<string, Field>;
  labels?: string[];
  accept?: (value: unknown) => boolean;
};

const text = (initial = '', label?: string): Field => ({ initial, label });
const number = (initial: number | string, label?: string): Field => ({ initial, label });
const colour = (initial = '#000000', label?: string): Field => ({ initial, label, colour: true });
const choice = (initial: string, choices: string[]): Field => ({ initial, choices });
const object = (fields: Fields, initial: unknown = {}): Field => ({ initial, fields });
const list = (item: Field, initial: unknown[] = []): Field => ({ initial, item });
const tuple = (item: Field, initial: unknown[], labels: string[]): Field => ({ ...list(item, initial), labels });
const variants = (initial: unknown, options: Record<string, Field>): Field => ({ initial, variants: options });
const point = variants([0, 0], {
  Coordinates: tuple(number(0), [0, 0], ['X', 'Y']),
  Object: object({ x: number(0), y: number(0) }, { x: 0, y: 0 }),
  Reference: text('view.centre'),
});
const opacity = { opacity: number(1), transparency: number(0) };
const glowFields: Fields = { colour: colour(), ...opacity, size: number(0.1), softness: number(1) };
const glowStart = { colour: '#000000', size: 0.1 };
const pairStart = { from: 'view.centre', to: 'view.centre' };
const twoPairStart = [{ from: [0, 0], to: [0, 0] }, { from: [1, 0], to: [0.5, 0] }];
const pair = variants(pairStart, {
  Object: object({ from: point, to: point }, pairStart),
  Pair: tuple(point, [[0, 0], [0, 0]], ['From', 'To']),
});
const coordinateLike = (value: unknown): boolean => typeof value === 'number'
  || (typeof value === 'string'
    && (!/^[^\s.]+\.(?:topLeft|topRight|bottomLeft|bottomRight|centre|center|top|bottom|left|right|points\.\d+)$/.test(value.trim())
      || /^view\.(?:top|bottom|left|right)$/.test(value.trim())));
const pointLike = (value: unknown): boolean => typeof value === 'string'
  || (record(value) && 'x' in value && 'y' in value)
  || (Array.isArray(value) && value.length === 2 && value.every(coordinateLike));
const singleAlignment = (value: unknown) => record(value)
  || (Array.isArray(value) && value.length === 2 && pointLike(value[0]));
const geometry: Fields = {
  name: text(), centre: point, width: number(1), height: number(1),
  topLeft: point, topRight: point, bottomLeft: point, bottomRight: point,
  rotation: variants(0, {
    Degrees: number(0),
    Units: object({ degrees: number(0), radians: number(0), deg: number(0), rad: number(0) }, { degrees: 0 }),
  }),
  ...opacity,
};
const paint: Fields = { colour: colour(), ...opacity, weight: number(1) };
const SHAPES: Record<string, { label: string; field: Field; initial: unknown }> = {
  rect: {
    label: 'Rectangle',
    field: object({ ...geometry, ...paint, glow: object(glowFields, glowStart) }),
    initial: { type: 'rect', centre: 'view.centre', width: 'view.width / 3', height: 'view.height / 3' },
  },
  circle: {
    label: 'Circle',
    field: object({ name: text(), centre: point, radius: number(0.5), points: list(point), ...paint }),
    initial: { type: 'circle', centre: 'view.centre', radius: 'view.width / 6' },
  },
  polygon: {
    label: 'Polygon',
    field: object({ name: text(), points: list(point), sides: number(3), centre: point, vertex: point, ...paint }),
    initial: { type: 'polygon', sides: 3, centre: 'view.centre', vertex: 'view.top' },
  },
  zoom: {
    label: 'Zoom',
    field: object({
      ...geometry, scale: number(0.5),
      glow: object({ ...glowFields, sourceOpacity: number(0) }, glowStart),
      blend: choice('normal', ['normal', 'multiply', 'screen', 'add', 'darken', 'lighten']),
      align: variants(pairStart, {
        'One pair': { ...pair, accept: singleAlignment },
        'Two pairs': {
          ...tuple(pair, twoPairStart, ['First pair', 'Second pair']),
          accept: (value) => Array.isArray(value) && !singleAlignment(value),
        },
      }),
    }),
    initial: { type: 'zoom', scale: 0.5, centre: 'view.centre' },
  },
};
const numericValue = variants(0, { Number: number(0), Boolean: { initial: true }, Point: point });
const VARIABLE_DEFAULTS: Record<string, unknown> = {
  number: 0, integer: 0, boolean: true, point: [0, 0], colour: '#000000', text: '',
  gradient: { stops: [{ position: 0, colour: '#000000' }, { position: 1, colour: '#ffffff' }] },
};
const VARIABLE_INPUTS: Record<string, string[]> = {
  number: ['slider', 'choice'], integer: ['slider', 'choice'], boolean: ['checkbox', 'choice'],
  point: ['click', 'drag', 'choice'], colour: ['choice'], text: ['choice'], gradient: ['choice'],
};
const variableTypeField = choice('number', Object.keys(VARIABLE_DEFAULTS));
const variableType = (variable: Record<string, unknown>): string => {
  if (typeof variable.type === 'string') return variable.type;
  const input = record(variable.input) ? variable.input.type : variable.input;
  if (input === 'checkbox' || typeof variable.value === 'boolean') return 'boolean';
  if (input === 'click' || input === 'drag' || Array.isArray(variable.value)
    || record(variable.value) && 'x' in variable.value && 'y' in variable.value) return 'point';
  return 'number';
};
const variableValueField = (type: string): Field => {
  if (type === 'colour') return colour();
  if (type === 'text') return text();
  if (type === 'point') return point;
  if (type === 'gradient') return gradientSpec;
  if (type === 'boolean') return variants(true, { Boolean: { initial: true }, Expression: text('true') });
  return number(0);
};
const gradientSpec = variants('palette', {
  Expression: text('palette'),
  Stops: object({
    stops: list(object({ position: number(0), colour: colour('#000000') }, { position: 0, colour: '#000000' })),
    space: choice('linear-srgb', ['linear-srgb', 'oklab', 'oklch']),
    hue: choice('shorter', ['shorter', 'longer', 'increasing', 'decreasing']),
  }, { stops: [{ position: 0, colour: '#000000' }, { position: 1, colour: '#ffffff' }] }),
});
const choiceOptionsField = list(object({ name: text(), value: numericValue }, { name: 'Option', value: 0 }));
const axis = (labels: string[]) => variants([-1, 1], {
  Range: tuple(number(0), [-1, 1], labels),
  Object: object({
    from: number(-1), to: number(1), min: number(-1), max: number(1),
  }, { from: -1, to: 1 }),
});
const TOP: Fields = {
  info: object({
    title: text(), author: text(), date: text(),
    description: { ...text(), multiline: true },
    links: list(variants('', {
      URL: text('https://'),
      'Titled link': object({ title: text(), url: text('https://') }, { title: '', url: 'https://' }),
    })),
  }),
  frame: object({
    width: number(12, 'Border width'), radius: number(6, 'Corner radius'),
    colour: colour('#444444', 'Border colour'), wall: colour('#dddddd', 'Wall colour'),
    background: colour('#ffffff', 'Background'), padding: number(12), margin: number(24),
  }),
  view: object({
    aspect: number('auto'),
    overflow: number(0),
    coordinates: object({
      x: axis(['Left', 'Right']),
      y: axis(['Bottom', 'Top']),
    }, { x: [-1, 1], y: [-1, 1] }),
  }),
  seed: variants('transparent', {
    Colour: colour('transparent'),
    Settings: object({ colour: colour(), ...opacity }, { colour: '#000000', opacity: 1 }),
  }),
  shading: object({
    mode: choice('paint', ['paint', 'density']),
    detail: number(0),
    scale: choice('log', ['log', 'sqrt', 'linear']),
    colours: variants(['#ffffff', '#000000'], {
      Expression: text('palette'),
      'Even stops': list(colour(), ['#ffffff', '#000000']),
      'Positioned stops': object({}, { '0%': '#ffffff', '100%': '#000000' }),
    }),
  }),
  variables: list(object({
    name: text('variable'), type: variableTypeField, value: numericValue,
  }, { name: 'variable', value: 0 })),
  colourSpace: choice('linear-srgb', ['linear-srgb', 'oklab', 'oklch']),
};
const TITLES: Record<string, string> = {
  info: 'Picture information', frame: 'Frame and wall', view: 'View',
  seed: 'Starting fill', shading: 'Shading', variables: 'Variables and inputs',
};
const DEFAULT_FIELDS: Record<string, unknown> = {
  info: { title: '', author: '', date: '', description: '' },
  frame: { width: 12, radius: 6, colour: '#444', wall: '#ddd', background: '#fff', padding: 12, margin: 24 },
  view: { aspect: 1, overflow: 0, coordinates: { x: [-100, 100], y: [-100, 100] } },
  shading: { mode: 'paint', detail: 0 },
};
const SPELLINGS: Record<string, string> = { color: 'colour', colors: 'colours', center: 'centre' };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const title = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const matches = (field: Field, value: unknown): boolean => field.accept ? field.accept(value) : field.variants
  ? Object.values(field.variants).some((option) => matches(option, value))
  : field.fields ? record(value) : field.item ? Array.isArray(value)
    : typeof field.initial === 'boolean' ? typeof value === 'boolean'
      : typeof value === 'number' || typeof value === 'string';
const inferred = (value: unknown): Field => Array.isArray(value)
  ? list(text()) : record(value) ? object({}) : { initial: value };
function colourValue(value: string): { hex: string; alpha: string } | undefined {
  if (!CSS.supports('color', value)) return undefined;
  const canvas = window.document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Colour editing needs a 2D canvas.');
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  const hex = (part: number) => part.toString(16).padStart(2, '0');
  return { hex: `#${hex(r)}${hex(g)}${hex(b)}`, alpha: a === 255 ? '' : hex(a) };
}

export type DefinitionForm = {
  element: HTMLElement;
  setText: (text: string) => void;
  setError: (message: string) => void;
  setActive: (active: boolean) => void;
  setInputControls: (controls: ReadonlyMap<string, HTMLElement>) => void;
};

export function createDefinitionForm(
  initialText: string,
  onEdit: (text: string) => void,
  onSelection: (indices: number[]) => void,
  frameControl: HTMLElement,
): DefinitionForm {
  const root = window.document.createElement('div');
  root.className = 'definition-form';
  const error = window.document.createElement('p');
  error.className = 'definition-error';
  error.setAttribute('role', 'status');
  const body = window.document.createElement('div');
  const undoStack: string[] = [];
  const redoStack: string[] = [];
  let source = initialText;
  let document = parseDocument(source);
  let editKey = '';
  let dragging: number | null = null;
  let cancelTouchDrag: (() => void) | undefined;
  let density = false;
  let active = true;
  let inputControls: ReadonlyMap<string, HTMLElement> = new Map();
  const inputSlots = new Map<string, HTMLElement>();
  let selected = '[]';
  const notifySelection = () => {
    const scene = body.querySelector<HTMLDetailsElement>('.definition-scene-section');
    const indices = active && scene?.open
      ? [...body.querySelectorAll<HTMLDetailsElement>('.definition-item')]
        .filter((card) => card.open).map((card) => Number(card.dataset.item))
      : [];
    const key = JSON.stringify(indices);
    if (key !== selected) {
      selected = key;
      onSelection(indices);
    }
  };
  const expanded = new Set<string>(['scene']);
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '') => {
    const element = window.document.createElement(tag);
    element.className = className;
    return element;
  };
  const button = (label: string, action: () => void, className = '') => {
    const element = make('button', className);
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  };
  const setError = (message: string) => {
    error.textContent = message;
    error.hidden = !message;
  };
  const toolbar = make('div', 'definition-history');
  const undo = button('Undo', () => restore(undoStack, redoStack));
  const redo = button('Redo', () => restore(redoStack, undoStack));
  toolbar.append(undo, redo);
  root.append(toolbar, error, body);

  function restore(from: string[], to: string[]) {
    const next = from.pop();
    if (next === undefined) return;
    to.push(source);
    source = next;
    document = parseDocument(source);
    editKey = '';
    render();
    onEdit(source);
  }

  function change(path: Path, action: () => void, structural = false) {
    const before = source;
    try {
      action();
      source = document.toString();
    } catch (cause) {
      document = parseDocument(before);
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (source === before) return;
    if (path[0] === 'scene' && path[2] === 'name' && typeof path[1] === 'number') {
      const summary = body.querySelector(`[data-item="${path[1]}"] summary`);
      const node = document.getIn(['scene', path[1]], true);
      const item: unknown = isMap(node) ? node.toJSON() : undefined;
      if (summary && record(item)) {
        const shape = typeof item.type === 'string' ? SHAPES[item.type] : undefined;
        const caption = `${path[1] + 1}. ${shape?.label ?? 'Unknown item'}${item.name ? ` - ${item.name}` : ''}`;
        const captionElement = summary.querySelector('.definition-item-caption');
        if (captionElement) captionElement.textContent = caption;
      }
    }
    const key = JSON.stringify(path);
    if (structural || key !== editKey) undoStack.push(before);
    editKey = structural ? '' : key;
    redoStack.length = 0;
    undo.disabled = undoStack.length === 0;
    redo.disabled = true;
    if (structural) render();
    onEdit(source);
  }
  // Object keys from toJS are strings; YAML density stops may have numeric keys.
  function documentPath(path: Path): Path {
    const resolved: Path = [];
    let node: unknown = document.contents;
    for (const part of path) {
      const pair = isMap(node)
        ? node.items.find(({ key }) => isScalar(key) && String(key.value) === String(part))
        : undefined;
      const key = pair && isScalar(pair.key) && (typeof pair.key.value === 'number' || typeof pair.key.value === 'string')
        ? pair.key.value : part;
      resolved.push(key);
      node = isMap(node) ? node.get(key, true) : isSeq(node) ? node.get(Number(key), true) : undefined;
    }
    return resolved;
  }
  const setNode = (path: Path, value: unknown) => document.setIn(documentPath(path), document.createNode(value));
  const set = (path: Path, value: unknown, structural = false) =>
    change(path, () => setNode(path, value), structural);
  const remove = (path: Path) => change(path, () => document.deleteIn(documentPath(path)), true);
  const variableAt = (index: number): Record<string, unknown> => {
    const value: unknown = document.toJS();
    const variable = record(value) && Array.isArray(value.variables) ? value.variables[index] : undefined;
    if (!record(variable)) throw new Error('Variable must be an object');
    return variable;
  };
  const configureInput = (index: number, type: string) => {
    const variable = variableAt(index);
    const value = variable.value;
    const label = record(variable.input) ? variable.input.label : undefined;
    change(['variables', index, 'input'], () => {
      if (type === '') {
        document.deleteIn(['variables', index, 'input']);
      } else if (type === 'slider') {
        const probe = document.clone();
        probe.setIn(['variables', index, 'input'], probe.createNode({ type, min: -Number.MAX_VALUE / 2, max: Number.MAX_VALUE / 2 }));
        const resolved = parseScene(probe.toString()).inputs.find((input) => input.name === variable.name);
        if (resolved?.type !== 'slider') throw new Error('Could not resolve the slider default');
        const start = resolved.value;
        setNode(['variables', index, 'input'], { type, min: Math.min(0, start), max: Math.max(1, start), ...(label ? { label } : {}) });
      } else if (type === 'checkbox' || type === 'click' || type === 'drag') {
        setNode(['variables', index, 'input'], { type, ...(label ? { label } : {}) });
      } else {
        setNode(['variables', index, 'input'], { type, options: [{ name: 'Default', value }], ...(label ? { label } : {}) });
      }
    }, true);
  };

  function disclosure(label: string, key: string) {
    const details = make('details', 'definition-section');
    details.open = expanded.has(key);
    const summary = make('summary');
    summary.textContent = label;
    details.append(summary);
    details.addEventListener('toggle', () => {
      if (!body.contains(details)) return;
      if (details.open) expanded.add(key);
      else expanded.delete(key);
      notifySelection();
    });
    return details;
  }

  function select(options: [string, string][], value: string, label: string) {
    const element = make('select');
    element.setAttribute('aria-label', label);
    options.forEach(([key, name]) => {
      const option = make('option');
      option.value = key;
      option.textContent = name;
      element.append(option);
    });
    element.value = value;
    return element;
  }

  function bin(label: string, action: () => void) {
    const control = button('', action, 'definition-item-action definition-bin');
    control.setAttribute('aria-label', label);
    control.title = label;
    const svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = window.document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7');
    svg.append(path);
    control.append(svg);
    return control;
  }

  function variableEditor(variable: Record<string, unknown>, index: number) {
    const container = make('div', 'definition-value');
    const path: Path = ['variables', index];
    const type = variableType(variable);
    const field = (label: string, editor: HTMLElement) => {
      const row = make('div', 'definition-field');
      const heading = make('div', 'definition-field-heading');
      heading.textContent = label;
      row.append(heading, editor);
      container.append(row);
      return row;
    };
    field('Name', fieldEditor(text(), variable.name ?? '', [...path, 'name'], 'Name'));
    field('Type', fieldEditor(variableTypeField, type, [...path, 'type'], 'Type'));
    const valueLabel = variable.input === undefined ? 'Value' : 'Default value';
    const valueRow = field(valueLabel, fieldEditor(variableValueField(type), variable.value ?? '', [...path, 'value'], valueLabel));
    if (typeof variable.name === 'string' && variable.input !== undefined) {
      const slot = make('div', 'definition-live-input');
      slot.setAttribute('role', 'group');
      slot.setAttribute('aria-label', `Live input: ${variable.name}`);
      inputSlots.set(variable.name, slot);
      const control = inputControls.get(variable.name);
      if (control) slot.append(control);
      valueRow.append(slot);
    }
    const input = record(variable.input) ? variable.input : { type: variable.input ?? '' };
    const kind = String(input.type);
    const kinds = VARIABLE_INPUTS[type] ?? [];
    const options: [string, string][] = [['', 'None'], ...kinds.map((kind): [string, string] => [kind, title(kind)])];
    if (kind && !kinds.includes(kind)) options.push([kind, title(kind)]);
    const selector = select(options, kind, 'Input');
    selector.addEventListener('change', () => {
      if (selector.value !== kind) configureInput(index, selector.value);
    });
    field('Input', selector);
    if (kind) {
      const label = fieldEditor(text(), input.label ?? '', [...path, 'input', 'label'], 'Label');
      label.querySelector('input')!.placeholder = String(variable.name ?? '');
      field('Label', label);
      if (kind === 'slider') {
        for (const key of ['min', 'max', 'step']) {
          field(title(key), fieldEditor(number(0), input[key] ?? '', [...path, 'input', key], title(key)));
        }
      } else if (kind === 'choice') {
        field('Options', fieldEditor(choiceOptionsField, input.options ?? [],
          [...path, 'input', 'options'], 'Options'));
      }
    }
    return container;
  }

  function fieldEditor(field: Field, value: unknown, path: Path, label: string, defaults?: unknown): HTMLElement {
    const container = make('div', 'definition-value');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', label);
    if (path[0] === 'variables' && path.length === 2 && record(value)) return variableEditor(value, Number(path[1]));
    if (field.variants) {
      const options = Object.entries(field.variants);
      const active = options.find(([, option]) => matches(option, value));
      const selector = select(options.map(([key]) => [key, key]), active?.[0] ?? '', `${label} format`);
      selector.addEventListener('change', () => {
        if (selector.value === active?.[0]) return;
        const next = field.variants![selector.value];
        // Changing from colour shorthand to seed settings keeps the colour.
        let replacement = next.initial;
        if (record(next.initial) && typeof value === 'string' && field.variants?.Colour) {
          replacement = { ...next.initial, colour: value };
        } else if (typeof next.initial === 'string' && record(value) && field.variants?.Colour) {
          replacement = value.colour ?? value.color ?? next.initial;
        } else if (Array.isArray(next.initial) && record(value) && 'x' in value && 'y' in value) {
          replacement = [value.x, value.y];
        } else if (record(next.initial) && 'x' in next.initial && Array.isArray(value) && value.length === 2) {
          replacement = { x: value[0], y: value[1] };
        } else if (Array.isArray(next.initial) && record(value) && 'from' in value && 'to' in value) {
          replacement = [value.from, value.to];
        } else if (record(next.initial) && 'from' in next.initial && Array.isArray(value) && value.length === 2) {
          replacement = { from: value[0], to: value[1] };
        } else if (record(next.initial) && 'degrees' in next.initial && (typeof value === 'number' || typeof value === 'string')) {
          replacement = { degrees: value };
        } else if (typeof next.initial === 'number' && record(value) && ('degrees' in value || 'deg' in value)) {
          replacement = value.degrees ?? value.deg;
        } else if (typeof next.initial === 'boolean' && typeof value === 'number') {
          replacement = value !== 0;
        } else if (typeof next.initial === 'number' && typeof value === 'boolean') {
          replacement = Number(value);
        }
        set(path, replacement, true);
      });
      container.append(selector, fieldEditor(active?.[1] ?? inferred(value), value, path, label));
      return container;
    }
    if (record(value)) {
      const fields = field.fields ?? {};
      const variableFields = path[0] === 'variables';
      const shown = { ...(variableFields ? Object.fromEntries(Object.entries(fields)
        .filter(([key]) => key !== 'stops').map(([key, spec]) => [key, spec.initial])) : {}),
        ...(record(defaults) ? defaults : {}), ...value };
      Object.entries(shown).forEach(([key, child]) => {
        if (key === 'type' && path[0] === 'scene') return;
        if (!(key in value) && Object.keys(value).some((written) => SPELLINGS[written] === key)) return;
        let spec = fields[SPELLINGS[key] ?? key] ?? (path[0] === 'shading' && ['colours', 'colors'].includes(String(path[1])) ? colour() : inferred(child));
        if (path[0] === 'variables' && key === 'value') {
          const sourceValue: unknown = document.toJS();
          const variable = path.length === 2 ? value : record(sourceValue) && Array.isArray(sourceValue.variables) ? sourceValue.variables[Number(path[1])] : undefined;
          if (record(variable)) {
            spec = variableValueField(variableType(variable));
          }
        }
        const row = make('div', 'definition-field');
        const header = make('div', 'definition-field-heading');
        const name = make('span');
        name.textContent = spec.label ?? title(key);
        const deleteButton = button('Remove', () => remove([...path, key]), 'definition-remove');
        deleteButton.setAttribute('aria-label', `Remove ${label}: ${name.textContent}`);
        header.append(name);
        if (key in value && !variableFields) header.append(deleteButton);
        row.append(header, fieldEditor(spec, child, [...path, key], name.textContent, record(defaults) ? defaults[key] : undefined));
        container.append(row);
      });
      const missing = Object.entries(fields).filter(([key]) => {
        if (key === 'opacity' && 'transparency' in value) return false;
        if (key === 'transparency' && 'opacity' in value) return false;
        if (path[0] === 'shading') {
          if (!density && ['scale', 'colours'].includes(key)) return false;
          if (density && key === 'detail') return false;
        }
        if (path[0] === 'scene' && path.length === 2) {
          if (!density && key === 'weight') return false;
          if (density && ['colour', 'opacity', 'transparency', 'glow', 'blend'].includes(key)) return false;
        }
        return !Object.keys(shown).some((written) => (SPELLINGS[written] ?? written) === key);
      });
      if (missing.length && !variableFields) {
        const add = select([['', '+ Add setting'], ...missing.map(([key, spec]): [string, string] => [key, spec.label ?? title(key)])], '', `Add ${label} setting`);
        add.className = 'definition-add';
        add.addEventListener('change', () => {
          if (add.value) set([...path, add.value], fields[add.value].initial, true);
        });
        container.append(add);
      } else if (Object.keys(fields).length === 0 && !variableFields) {
        const entry = make('div', 'definition-list-entry');
        entry.classList.add('definition-stop-entry');
        const position = make('input');
        position.placeholder = 'Position, e.g. 50%';
        position.setAttribute('aria-label', 'New colour stop position');
        const add = button('+ Add stop', () => {
          const key = position.value.trim();
          if (!key || key in value) {
            position.setCustomValidity(key ? 'This position already exists.' : 'Enter a position.');
            position.reportValidity();
            return;
          }
          set([...path, key], '#888888', true);
        }, 'definition-add');
        position.addEventListener('input', () => position.setCustomValidity(''));
        entry.append(position, add);
        container.append(entry);
      }
      return container;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        const row = make('div', 'definition-list-entry');
        const spec = field.item ?? inferred(child);
        const childLabel = field.labels?.[index] ?? `${label} ${index + 1}`;
        const heading = make('span', 'definition-coordinate-label');
        heading.textContent = field.labels?.[index] ?? String(index + 1);
        if (path.length === 1 && path[0] === 'variables') {
          const card = disclosure('', `variables.${index}`);
          card.classList.add('definition-variable');
          heading.textContent = `${index + 1}${record(child) && child.name ? ` - ${child.name}` : ''}`;
          const header = card.querySelector('summary')!;
          header.className = 'definition-variable-heading';
          header.append(heading, bin(`Delete variable ${index + 1}`, () => {
            const open = value.map((_, i) => body.querySelectorAll<HTMLDetailsElement>('.definition-variable')[i]?.open ?? false);
            open.splice(index, 1);
            value.forEach((_, i) => expanded.delete(`variables.${i}`));
            open.forEach((isOpen, i) => { if (isOpen) expanded.add(`variables.${i}`); });
            remove([...path, index]);
          }));
          const settings = make('div', 'definition-section-body');
          settings.append(fieldEditor(spec, child, [...path, index], childLabel));
          card.append(settings);
          container.append(card);
          return;
        }
        row.append(heading, fieldEditor(spec, child, [...path, index], childLabel));
        if (!field.labels || value.length !== field.labels.length) {
          const del = path[0] === 'variables'
            ? bin(`Delete ${childLabel}`, () => remove([...path, index]))
            : button('Remove', () => remove([...path, index]), 'definition-remove');
          if (path[0] !== 'variables') del.setAttribute('aria-label', `Remove ${childLabel}`);
          row.append(del);
        }
        container.append(row);
      });
      if (!field.labels || value.length !== field.labels.length) {
        container.append(button('+ Add', () => {
          let next = (field.item ?? text()).initial;
          if (path.length === 1 && path[0] === 'variables' && record(next)) {
            const names = new Set(value.filter(record).map((variable) => variable.name));
            let name = 'variable';
            for (let index = 2; names.has(name); index += 1) name = `variable${index}`;
            next = { ...next, name, type: 'number' };
            expanded.add(`variables.${value.length}`);
          } else if (path[0] === 'variables' && path.length === 4 && path[2] === 'input' && path[3] === 'options') {
            const names = new Set(value.filter(record).map((option) => option.name));
            let name = 'Option';
            for (let index = 2; names.has(name); index += 1) name = `Option ${index}`;
            next = { name, value: variableAt(Number(path[1])).value };
          } else if (path[0] === 'variables' && path.at(-1) === 'stops') {
            const positions = value.filter(record).map((stop) => stop.position).filter((position): position is number =>
              typeof position === 'number' && position >= 0 && position <= 1).sort((a, b) => a - b);
            const bounds = [0, ...positions, 1];
            let start = 0;
            let end = 1;
            let gap = -1;
            bounds.slice(1).forEach((position, index) => {
              if (position - bounds[index] > gap) {
                start = bounds[index];
                end = position;
                gap = end - start;
              }
            });
            next = { position: (start + end) / 2, colour: '#888888' };
          }
          set([...path, value.length], next, true);
        }, 'definition-add'));
      }
      return container;
    }
    if (field.choices) {
      const current = String(value);
      const optional = path[0] === 'variables' && ['space', 'hue'].includes(String(path.at(-1)));
      const choices = field.choices.includes(current) ? field.choices : [current, ...field.choices];
      const input = select([...(optional ? [['', 'Default'] as [string, string]] : []),
        ...choices.map((key): [string, string] => [key, title(key)])], optional && document.getIn(documentPath(path)) === undefined ? '' : current, label);
      input.addEventListener('change', () => {
        if (optional && input.value === '') {
          remove(path);
        } else if (path[0] === 'variables' && path.length === 3 && path[2] === 'type') {
          const index = Number(path[1]);
          const variable = variableAt(index);
          change(path, () => {
            setNode(path, input.value);
            const value = variable.value;
            const compatible = variable.type === input.value
              || input.value === 'number' && variable.type === 'integer'
              || (input.value === 'number' ? typeof value === 'number'
              : input.value === 'integer' ? typeof value === 'number' && Number.isInteger(value)
                : input.value === 'boolean' ? typeof value === 'boolean'
                  : input.value === 'point' ? pointLike(value) && typeof value !== 'string'
                    : input.value === 'colour' ? typeof value === 'string' && CSS.supports('color', value)
                      : input.value === 'text' ? typeof value === 'string'
                        : record(value) && Array.isArray(value.stops));
            if (!compatible) {
              setNode(['variables', index, 'value'], VARIABLE_DEFAULTS[input.value]);
            }
            if (variable.type !== input.value && variable.input !== undefined) {
              const kind = record(variable.input) ? variable.input.type : variable.input;
              if (!VARIABLE_INPUTS[input.value]?.includes(String(kind))) document.deleteIn(['variables', index, 'input']);
              else if (!compatible && kind === 'choice') {
                setNode(['variables', index, 'input', 'options'], [{ name: 'Default', value: variableAt(index).value }]);
              }
            }
          }, true);
        } else set(path, input.value, true);
      });
      container.append(input);
      return container;
    }
    const input = field.multiline ? make('textarea') : make('input');
    input.setAttribute('aria-label', label);
    input.dataset.path = JSON.stringify(path);
    if (input instanceof HTMLInputElement && typeof value === 'boolean') {
      input.type = 'checkbox';
      input.checked = value;
      input.addEventListener('change', () => set(path, input.checked));
    } else {
      input.value = value === null ? '' : String(value);
      if (input instanceof HTMLTextAreaElement) input.rows = 3;
      input.addEventListener('focus', () => { editKey = ''; });
      input.addEventListener('input', () => {
        const written = input.value;
        if (path[0] === 'variables' && written.trim() === '' && path[2] === 'input' && ['label', 'step'].includes(String(path[3]))) {
          if (record(variableAt(Number(path[1])).input)) change(path, () => document.deleteIn(documentPath(path)));
          return;
        }
        if (path[0] === 'variables' && path[2] === 'input' && typeof variableAt(Number(path[1])).input === 'string') {
          change(path, () => {
            setNode(['variables', Number(path[1]), 'input'], { type: variableAt(Number(path[1])).input });
            setNode(path, written);
          });
          return;
        }
        const next = typeof field.initial === 'number' || typeof value === 'number'
          ? (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(written.trim()) ? Number(written) : written)
          : written;
        set(path, next);
        if (path[0] === 'variables' && path.length === 3 && path[2] === 'name') {
          const card = input.closest('.definition-variable');
          const heading = card?.querySelector('.definition-variable-heading span');
          if (heading) heading.textContent = `${Number(path[1]) + 1}${written ? ` - ${written}` : ''}`;
          const slot = card?.querySelector<HTMLElement>('.definition-live-input');
          if (slot) {
            for (const [name, existing] of inputSlots) if (existing === slot) inputSlots.delete(name);
            inputSlots.set(written, slot);
            slot.setAttribute('aria-label', `Live input: ${written}`);
          }
          const label = card?.querySelector<HTMLInputElement>('input[aria-label="Label"]');
          if (label) label.placeholder = written;
        }
      });
    }
    container.append(input);
    if (field.colour && typeof value === 'string') {
      const picker = make('input', 'definition-colour');
      picker.type = 'color';
      picker.setAttribute('aria-label', `${label} picker`);
      const refresh = () => {
        const current = colourValue(input.value);
        picker.disabled = !current;
        picker.title = current ? 'Choose a colour' : 'Edit this colour expression in the text field';
        if (current) picker.value = current.hex;
      };
      refresh();
      input.addEventListener('input', refresh);
      picker.addEventListener('input', () => {
        input.value = picker.value + (colourValue(input.value)?.alpha ?? '');
        set(path, input.value);
      });
      container.classList.add('definition-colour-value');
      container.append(picker);
    }
    return container;
  }

  function move(from: number, to: number) {
    const node = document.get('scene', true);
    if (!isSeq(node) || from === to || to < 0 || to >= node.items.length) return;
    body.querySelectorAll<HTMLDetailsElement>('.definition-item').forEach((card) => {
      const key = `scene.${card.dataset.item}`;
      if (card.open) expanded.add(key);
      else expanded.delete(key);
    });
    const openItems = [...expanded].filter((key) => key.startsWith('scene.'));
    openItems.forEach((key) => expanded.delete(key));
    openItems.forEach((key) => {
      const index = Number(key.slice('scene.'.length));
      const next = index === from ? to : from < to && index > from && index <= to ? index - 1
        : from > to && index >= to && index < from ? index + 1 : index;
      expanded.add(`scene.${next}`);
    });
    change(['scene'], () => {
      const [item] = node.items.splice(from, 1);
      node.items.splice(to, 0, item);
    }, true);
    body.querySelector<HTMLElement>(`[data-item="${to}"] summary`)?.focus();
  }

  function render() {
    cancelTouchDrag?.();
    inputSlots.clear();
    body.replaceChildren();
    undo.disabled = undoStack.length === 0;
    redo.disabled = redoStack.length === 0;
    setError('');
    if (document.errors.length || !isMap(document.contents)) {
      setError(document.errors[0]?.message ?? 'The definition must be an object. Open YAML to repair it.');
      return;
    }
    let value: unknown;
    try {
      value = document.toJS();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (!record(value)) return;
    density = record(value.shading) && value.shading.mode === 'density';
    if (record(value.shading) && typeof value.shading.mode === 'string'
      && !['paint', 'density'].includes(value.shading.mode)) {
      try {
        density = parseScene(source).shading.mode === 'density';
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    const scene = disclosure('Scene', 'scene');
    scene.classList.add('definition-scene-section');
    const content = make('div', 'definition-section-body');
      content.classList.add('definition-scene-list');
      const insertionLine = make('div', 'definition-insertion-line');
      insertionLine.hidden = true;
      insertionLine.setAttribute('aria-hidden', 'true');
      let insertionIndex: number | null = null;
      const clearInsertion = () => {
        insertionLine.hidden = true;
        insertionIndex = null;
      };
      const showInsertion = (x: number, y: number) => {
        const bounds = content.getBoundingClientRect();
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
          clearInsertion();
          return;
        }
        const cards = [...content.querySelectorAll<HTMLElement>('[data-item]')];
        if (!cards.length) return;
        const slot = cards.findIndex((card) => {
          const rect = card.getBoundingClientRect();
          return y < rect.top + rect.height / 2;
        });
        insertionIndex = slot === -1 ? cards.length : slot;
        const previous = cards[insertionIndex - 1]?.getBoundingClientRect();
        const next = cards[insertionIndex]?.getBoundingClientRect();
        const top = previous && next ? (previous.bottom + next.top) / 2
          : next ? next.top - 5 : previous!.bottom + 5;
        insertionLine.style.top = `${top - bounds.top}px`;
        insertionLine.hidden = false;
      };
      const insert = (from: number) => {
        const slot = insertionIndex;
        clearInsertion();
        if (slot !== null) move(from, slot > from ? slot - 1 : slot);
      };
      content.addEventListener('dragover', (event) => {
        if (dragging === null) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        showInsertion(event.clientX, event.clientY);
      });
      content.addEventListener('dragleave', (event) => {
        if (!(event.relatedTarget instanceof Node) || !content.contains(event.relatedTarget)) clearInsertion();
      });
      content.addEventListener('drop', (event) => {
        if (dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        showInsertion(event.clientX, event.clientY);
        const from = dragging;
        dragging = null;
        insert(from);
      });
    const add = select([['', '+ Add item'], ...Object.entries(SHAPES).map(([key, shape]): [string, string] => [key, shape.label])], '', 'Add scene item');
    add.className = 'definition-add-item';
    for (const option of add.options) {
      if (SHAPES[option.value]) option.className = `definition-item-${option.value}`;
    }
    const addOption = add.options[0];
    addOption.textContent = '+';
    addOption.hidden = true;
    addOption.disabled = true;
    const sceneHeading = scene.querySelector('summary')!;
    const sceneTitle = make('span');
    sceneTitle.textContent = 'Scene';
    sceneHeading.replaceChildren(sceneTitle, add);
    add.addEventListener('click', (event) => event.stopPropagation());
    add.addEventListener('keydown', (event) => event.stopPropagation());
    const items = value.scene;
    add.addEventListener('change', () => {
      if (!add.value) return;
      const index = Array.isArray(items) ? items.length : 0;
      expanded.add(`scene.${index}`);
      if (items === undefined) set(['scene'], [SHAPES[add.value].initial], true);
      else if (Array.isArray(items)) set(['scene', index], SHAPES[add.value].initial, true);
      body.querySelector<HTMLElement>(`[data-item="${index}"] summary`)?.focus();
    });
    if (Array.isArray(items)) {
      items.forEach((item, index) => {
        const shape = record(item) && typeof item.type === 'string' ? SHAPES[item.type] : undefined;
        const label = `${index + 1}. ${shape?.label ?? 'Unknown item'}${record(item) && item.name ? ` - ${item.name}` : ''}`;
        const card = disclosure(label, `scene.${index}`);
        card.classList.add('definition-item');
        if (record(item) && typeof item.type === 'string' && SHAPES[item.type]) {
          card.classList.add(`definition-item-${item.type}`);
        }
        card.dataset.item = String(index);
        const tools = make('div', 'definition-item-tools');
        const summary = card.querySelector('summary')!;
        const caption = make('span', 'definition-item-caption');
        caption.textContent = label;
        summary.replaceChildren(caption, tools);
        const handle = summary;
        handle.draggable = true;
        handle.title = 'Drag to reorder; Alt+Up/Down moves this item';
        let suppressClick = false;
        tools.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        tools.addEventListener('pointerdown', (event) => event.stopPropagation());
        tools.addEventListener('dragstart', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        summary.addEventListener('click', (event) => {
          if (suppressClick) {
            event.preventDefault();
            suppressClick = false;
          }
        });
        handle.addEventListener('dragstart', (event) => {
          suppressClick = true;
          dragging = index;
          card.classList.add('definition-item-lifted');
          event.dataTransfer?.setData('text/plain', String(index));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        handle.addEventListener('dragend', () => {
          dragging = null;
          card.classList.remove('definition-item-lifted');
          clearInsertion();
          window.setTimeout(() => { suppressClick = false; }, 0);
        });
        let touchPointer: number | undefined;
        let holdTimer: number | undefined;
        let touchDragging = false;
        let touchOrigin = { x: 0, y: 0 };
        let touchPreview: HTMLDivElement | undefined;
        const positionTouchPreview = (x: number, y: number) => {
          if (touchPreview) {
            touchPreview.style.transform = `translate(${x - touchOrigin.x}px, ${y - touchOrigin.y}px)`;
          }
        };
        const cancelTouch = () => {
          window.clearTimeout(holdTimer);
          holdTimer = undefined;
          touchPreview?.remove();
          touchPreview = undefined;
          if (touchPointer !== undefined && handle.hasPointerCapture(touchPointer)) {
            handle.releasePointerCapture(touchPointer);
          }
          touchPointer = undefined;
          touchDragging = false;
          handle.draggable = true;
          card.classList.remove('definition-item-lifted');
          clearInsertion();
          if (cancelTouchDrag === cancelTouch) cancelTouchDrag = undefined;
        };
        handle.addEventListener('pointerdown', (event) => {
          if (event.pointerType === 'mouse') return;
          cancelTouchDrag?.();
          suppressClick = false;
          if (!event.isPrimary) return;
          touchPointer = event.pointerId;
          touchOrigin = { x: event.clientX, y: event.clientY };
          handle.draggable = false;
          cancelTouchDrag = cancelTouch;
          holdTimer = window.setTimeout(() => {
            holdTimer = undefined;
            touchDragging = true;
            suppressClick = true;
            const bounds = card.getBoundingClientRect();
            touchPreview = make('div', 'definition-form definition-drag-preview');
            touchPreview.setAttribute('aria-hidden', 'true');
            touchPreview.inert = true;
            touchPreview.style.left = `${bounds.left}px`;
            touchPreview.style.top = `${bounds.top}px`;
            touchPreview.style.width = `${bounds.width}px`;
            const previewCard = make('details', card.className);
            previewCard.classList.add('definition-item-lifted');
            previewCard.append(handle.cloneNode(true));
            touchPreview.append(previewCard);
            window.document.body.append(touchPreview);
            card.classList.add('definition-item-lifted');
            handle.setPointerCapture(event.pointerId);
            showInsertion(touchOrigin.x, touchOrigin.y);
          }, 1000);
        });
        handle.addEventListener('touchmove', (event) => {
          if (touchDragging) event.preventDefault();
        }, { passive: false });
        handle.addEventListener('contextmenu', (event) => {
          if (touchPointer !== undefined) event.preventDefault();
        });
        handle.addEventListener('pointermove', (event) => {
          if (event.pointerId !== touchPointer) return;
          if (!touchDragging) {
            if (Math.hypot(event.clientX - touchOrigin.x, event.clientY - touchOrigin.y) > 8) cancelTouch();
            return;
          }
          positionTouchPreview(event.clientX, event.clientY);
          showInsertion(event.clientX, event.clientY);
          const controls = root.closest('.controls');
          if (controls) {
            const bounds = controls.getBoundingClientRect();
            if (event.clientY < bounds.top + 40) controls.scrollBy(0, -12);
            else if (event.clientY > bounds.bottom - 40) controls.scrollBy(0, 12);
          }
        });
        handle.addEventListener('pointerup', (event) => {
          if (event.pointerId !== touchPointer) return;
          if (touchDragging) insert(index);
          cancelTouch();
          window.setTimeout(() => { suppressClick = false; }, 0);
        });
        handle.addEventListener('pointercancel', (event) => {
          if (event.pointerId === touchPointer) cancelTouch();
        });
        handle.addEventListener('lostpointercapture', () => {
          if (touchPointer !== undefined) cancelTouch();
        });
        summary.addEventListener('keydown', (event) => {
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
        });
        const up = button('Move up', () => move(index, index - 1));
        const down = button('Move down', () => move(index, index + 1));
        up.disabled = index === 0;
        down.disabled = index === items.length - 1;
        const del = button('Delete', () => {
          expanded.delete(`scene.${index}`);
          const after = [...expanded].filter((key) => key.startsWith('scene.') && Number(key.slice(6)) > index);
          after.forEach((key) => expanded.delete(key));
          after.forEach((key) => expanded.add(`scene.${Number(key.slice(6)) - 1}`));
          remove(['scene', index]);
          body.querySelector<HTMLElement>(`[data-item="${Math.min(index, items.length - 2)}"] summary`)?.focus();
        }, 'definition-remove');
        const icon = (control: HTMLButtonElement, name: string, path: string) => {
          control.setAttribute('aria-label', `${name}: ${label}`);
          control.title = name;
          control.className = 'definition-item-action';
          const svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('aria-hidden', 'true');
          const drawing = window.document.createElementNS('http://www.w3.org/2000/svg', 'path');
          drawing.setAttribute('d', path);
          svg.append(drawing);
          control.replaceChildren(svg);
        };
        icon(up, 'Move up', 'M12 19V5M5 12l7-7 7 7');
        icon(down, 'Move down', 'M12 5v14M5 12l7 7 7-7');
        icon(del, 'Delete', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7');
        tools.append(up, down, del);
        const settings = make('div', 'definition-section-body');
        settings.append(fieldEditor(shape?.field ?? inferred(item), item, ['scene', index], label));
        card.append(settings);
        content.append(card);
      });
      if (!items.length) {
        const hint = make('p', 'definition-hint');
        hint.textContent = 'Add a shape or zoom to start your picture. Later items draw on top.';
        content.append(hint);
      }
    } else if (items !== undefined) {
      setError('Scene must be a list. Open YAML to repair it.');
    }
    content.append(insertionLine);
    scene.append(content);
    body.append(scene);
    const group = (label: string, key: string, fields: string[]) => {
      const section = disclosure(label, key);
      const content = make('div', 'definition-section-body');
      fields.forEach((fieldKey) => {
        if (fieldKey === 'seed' && density && !(fieldKey in value)) return;
        const heading = make('h3', 'definition-group-heading');
        heading.textContent = fieldKey === 'view' ? 'Area' : fieldKey === 'colourSpace' ? 'Colour mixing space' : TITLES[fieldKey];
        content.append(heading);
        if (fieldKey === 'frame') content.append(frameControl);
        const defaults = fieldKey === 'shading' && density
          ? { mode: 'density', scale: 'log', colours: ['#fef3c7', '#c2410c', '#1c1917'] }
          : DEFAULT_FIELDS[fieldKey];
        content.append(fieldEditor(TOP[fieldKey], fieldKey in value ? value[fieldKey] : defaults ?? TOP[fieldKey].initial,
          [fieldKey], TITLES[fieldKey] ?? 'Colour mixing space', defaults));
        if (fieldKey === 'seed') {
          const hint = make('p', 'definition-hint');
          hint.textContent = 'Fills the deepest zoom copies.';
          content.append(hint);
        }
      });
      section.append(content);
      body.append(section);
    };
    group('Picture', 'picture', ['view', 'shading', 'seed', 'colourSpace']);
    group('Controls', 'controls', ['variables']);
    group('Presentation', 'presentation', ['frame', 'info']);
    notifySelection();
  }
  render();
  return {
    element: root,
    setText: (next) => {
      if (next.trim() === source.trim()) return;
      source = next;
      document = parseDocument(source);
      undoStack.length = 0;
      redoStack.length = 0;
      editKey = '';
      render();
    },
    setError,
    setInputControls: (controls) => {
      inputControls = controls;
      inputSlots.forEach((slot, name) => {
        const control = controls.get(name);
        slot.replaceChildren(...(control ? [control] : []));
      });
    },
    setActive: (next) => {
      if (!next) cancelTouchDrag?.();
      active = next;
      notifySelection();
    },
  };
}

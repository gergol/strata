import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDescriptorYaml } from '../src/descriptor.js';

/**
 * Doc-vs-code drift guard: the flagship example descriptor in requirements §6
 * must validate against the implemented schema. If either side changes without
 * the other, this fails — the audit found exactly that drift once already.
 */
describe('requirements §6 example descriptor', () => {
  it('passes the implemented schema', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../docs/requirements.md', import.meta.url)),
      'utf8',
    );
    const match = /```yaml\n([\s\S]*?)```/.exec(doc);
    expect(match, 'requirements.md must contain a yaml example block').not.toBeNull();
    const d = loadDescriptorYaml((match as RegExpExecArray)[1] as string);
    expect(d.id).toBe('soilgrids_ph');
    expect(d.value_type).toBe('numeric');
    expect(d.unit).toBe('pH');
    expect(d.scale_factor).toBe(0.1);
  });
});

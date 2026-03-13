import { describe, expect, test } from 'bun:test';
import {
  approvalDecisionOptionsFromValue,
  approvalPolicyForMode,
  buildGrantedPermissions,
  extractRequestedWriteRoots,
  formatEffortLabel,
  parseModelEffortOptions,
  threadStatusTypeFromValue
} from './codexProtocol';

describe('codexProtocol', () => {
  test('reads thread status from both string and object payloads', () => {
    expect(threadStatusTypeFromValue('idle')).toBe('idle');
    expect(threadStatusTypeFromValue({ type: 'notLoaded' })).toBe('notLoaded');
    expect(threadStatusTypeFromValue({})).toBe('');
  });

  test('parses approval decisions and falls back to safe defaults', () => {
    expect(approvalDecisionOptionsFromValue(['decline', 'accept'])).toEqual(['decline', 'accept']);
    expect(approvalDecisionOptionsFromValue(null)).toEqual(['accept', 'acceptForSession', 'decline']);
  });

  test('maps access modes to stable app-server approval policy values', () => {
    expect(approvalPolicyForMode('full-access')).toBe('never');
    expect(approvalPolicyForMode('need-approve')).toBe('untrusted');
  });

  test('formats reasoning effort labels', () => {
    expect(formatEffortLabel('xhigh')).toBe('Xhigh');
    expect(formatEffortLabel('very-high')).toBe('Very High');
  });

  test('parses model effort options from stable and compatibility payloads', () => {
    expect(
      parseModelEffortOptions({
        supportedReasoningEfforts: [{ reasoningEffort: 'xhigh', description: 'extra depth' }]
      })
    ).toEqual([{ id: 'xhigh', label: 'Xhigh', description: 'extra depth' }]);

    expect(
      parseModelEffortOptions({
        reasoningEffort: [{ effort: 'medium', description: 'balanced' }]
      })
    ).toEqual([{ id: 'medium', label: 'Medium', description: 'balanced' }]);
  });

  test('extracts and subsets requested write roots', () => {
    const requested = {
      fileSystem: {
        write: ['/a', '/b']
      },
      macos: {
        accessibility: true
      }
    };

    expect(extractRequestedWriteRoots(requested)).toEqual(['/a', '/b']);
    expect(buildGrantedPermissions(requested, ['/b'])).toEqual({
      fileSystem: {
        write: ['/b']
      },
      macos: {
        accessibility: true
      }
    });
    expect(buildGrantedPermissions(requested, [])).toEqual({
      macos: {
        accessibility: true
      }
    });
  });
});

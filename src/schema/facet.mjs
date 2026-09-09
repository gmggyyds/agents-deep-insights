/**
 * Facet 契约：单会话结构化打标的唯一真源。
 *
 * 这里的枚举表来自对 Claude Code 官方 /insights 的行为观察（见 docs/DESIGN.md §2），
 * 并按 Codex（大量 shell exec）场景做了增补。
 *
 * 关键设计：枚举写进 JSON Schema 的 enum / properties，而不是只写在 prompt 里。
 * 实测证据：prompt-only 模式 3 次里 2 次产出违规结构（docs/DESIGN.md §2.2）。
 */

export const OUTCOME = [
  'not_achieved', 'partially_achieved', 'mostly_achieved',
  'fully_achieved', 'unclear_from_transcript',
];

export const SESSION_TYPE = [
  'single_task', 'multi_task', 'iterative_refinement', 'exploration', 'quick_question',
];

export const GOAL_CATEGORIES = [
  'debug_investigate', 'implement_feature', 'fix_bug', 'write_script_tool',
  'refactor_code', 'configure_system', 'create_pr_commit', 'analyze_data',
  'understand_codebase', 'write_tests', 'write_docs', 'deploy_infra',
  'warmup_minimal', // 纯预热/无实质内容的会话，命中后整条剔除
];

export const FRICTION = [
  'misunderstood_request', 'wrong_approach', 'buggy_code', 'user_rejected_action',
  'agent_got_blocked', 'user_stopped_early', 'wrong_file_or_location',
  'excessive_changes', 'slow_or_verbose', 'tool_failed', 'user_unclear',
  'external_issue',
];

/** 归因：只有 user-actionable 的摩擦才进规则候选。官方没有这一维。 */
export const ATTRIBUTION = ['user_actionable', 'agent_capability', 'environmental'];

/**
 * 常见同义词 → 表内 key。
 * 全部来自真实观测：官方 /insights 在本机产出 35 类 friction / 171 类 goal，
 * 其中同义词碎片直接改变了排序（工具类真实 25，报告只显示 17）。
 */
export const ALIASES = {
  // 工具类：官方枚举写 tool_failed，实际产出全是这些
  tool_failure: 'tool_failed',
  tool_limitation: 'tool_failed',
  tool_automation_failure: 'tool_failed',
  tooling_failure: 'tool_failed',
  // 环境类：本机观测到被拆成 5 个词条
  environment_issue: 'external_issue',
  environment_issues: 'external_issue',
  environment_setup: 'external_issue',
  tooling_environment_issues: 'external_issue',
  tool_environment_issues: 'external_issue',
  external_blocker: 'external_issue',
  // 其他
  claude_got_blocked: 'agent_got_blocked',
  incorrect_assumption: 'wrong_approach',
  unwanted_output_loop: 'slow_or_verbose',
};

/** strict mode 要求每层 required 列全该层 properties 的每一个 key。 */
function denseCounts(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'integer' }])),
    required: [...keys],
  };
}

export function facetSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      outcome: { type: 'string', enum: OUTCOME },
      session_type: { type: 'string', enum: SESSION_TYPE },
      goal_categories: denseCounts(GOAL_CATEGORIES),
      friction_counts: denseCounts(FRICTION),
      friction_attribution: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(ATTRIBUTION.map((a) => [a, { type: 'integer' }])),
        required: [...ATTRIBUTION],
      },
      friction_detail: { type: 'string' },
      user_instructions: { type: 'array', items: { type: 'string' } },
      brief_summary: { type: 'string' },
    },
    required: [
      'outcome', 'session_type', 'goal_categories', 'friction_counts',
      'friction_attribution', 'friction_detail', 'user_instructions', 'brief_summary',
    ],
  };
}

export const ENUM_OF = {
  outcome: OUTCOME,
  session_type: SESSION_TYPE,
};

export const COUNT_KEYS_OF = {
  goal_categories: GOAL_CATEGORIES,
  friction_counts: FRICTION,
  friction_attribution: ATTRIBUTION,
};

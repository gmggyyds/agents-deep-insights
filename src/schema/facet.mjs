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

/**
 * 归因：只有 user_actionable 的摩擦才进规则候选。官方没有这一维。
 *
 * v0.3 起改为**按摩擦类别逐个归因**，不再是会话级三个总数。
 * 原因（外部复测实测）：只有会话级总数时，无法把责任绑到具体类别——
 * 一个会话里只要出现任何 user_actionable 摩擦，纯环境的 tool_failed 也会跟着
 * 进入规则候选。而写成规则也改不掉环境问题。
 *
 * `unknown` 是必须的：原因不明的工具失败应当单列，不能默认塞进 environmental
 * 充数——那会让归因比例看起来精确，实际是把「不知道」伪装成「不怪你」。
 */
/**
 * 主要成功类型。取自官方 /insights 本机 54 条产物的实测取值全集
 * （good_debugging 20 / multi_file_changes 17 / fast_accurate_search 7 /
 *  proactive_help 7 / good_explanations 2 / none 1），按 Codex 场景补两项。
 *
 * 用途：驱动报告「你做得漂亮的地方」一段。没有这一维时那段只能写空话——
 * 这是 v0.3 报告比官方薄 21 倍的结构性原因之一。
 */
export const PRIMARY_SUCCESS = [
  'good_debugging', 'multi_file_changes', 'fast_accurate_search', 'proactive_help',
  'good_explanations', 'long_autonomous_run', 'caught_own_mistake', 'none',
];

/** 助手这次到底有多大用。官方实测取值：essential / very_helpful / moderately_helpful / unhelpful。 */
export const HELPFULNESS = ['essential', 'very_helpful', 'moderately_helpful', 'slightly_helpful', 'unhelpful'];

/** 用户满意度。官方是开放词表（漂出过 happy / neutral），这里闭合以保证可比。 */
export const SATISFACTION = ['satisfied', 'likely_satisfied', 'neutral', 'dissatisfied'];

export const ATTRIBUTION = ['user_actionable', 'agent_capability', 'environmental', 'unknown'];

/** 每类摩擦的归因取值；none 表示该类别本次未发生。 */
export const ATTRIBUTION_OR_NONE = ['none', ...ATTRIBUTION];

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
      // 逐类别归因：key 是摩擦类别，value 是该类摩擦这次该归给谁
      friction_attribution: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          FRICTION.map((f) => [f, { type: 'string', enum: ATTRIBUTION_OR_NONE }]),
        ),
        required: [...FRICTION],
      },
      friction_detail: { type: 'string' },
      user_instructions: { type: 'array', items: { type: 'string' } },
      brief_summary: { type: 'string' },
      // ↓ 叙事层。枚举负责「可比的计数」，这几个自由文本负责「具体到能写进报告」。
      // 官方靠开放词表拿到具体性，代价是 171 个 goal 类别互相漂移、计数不可比；
      // 分成两层就不用二选一。
      underlying_goal: { type: 'string' },
      primary_success: { type: 'string', enum: PRIMARY_SUCCESS },
      claude_helpfulness: { type: 'string', enum: HELPFULNESS },
      user_satisfaction_counts: denseCounts(SATISFACTION),
    },
    required: [
      'outcome', 'session_type', 'goal_categories', 'friction_counts',
      'friction_attribution', 'friction_detail', 'user_instructions', 'brief_summary',
      'underlying_goal', 'primary_success', 'claude_helpfulness', 'user_satisfaction_counts',
    ],
  };
}

export const ENUM_OF = {
  outcome: OUTCOME,
  session_type: SESSION_TYPE,
  primary_success: PRIMARY_SUCCESS,
  claude_helpfulness: HELPFULNESS,
};

export const COUNT_KEYS_OF = {
  goal_categories: GOAL_CATEGORIES,
  friction_counts: FRICTION,
  user_satisfaction_counts: SATISFACTION,
};

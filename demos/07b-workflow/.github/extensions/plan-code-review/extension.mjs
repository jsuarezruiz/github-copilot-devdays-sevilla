// Multi-model workflow: plan, code, review and, if needed, escalate.
//
// Each phase delegates to an agent in .github/agents, which brings its own model.
// It is the HydraFusion idea (a critic from another model family and cascade
// escalation), but with the models, the order and the limits written in code.
//
// Dynamic Workflows is in preview. In the CLI you need /experimental on.
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

// Model for the second attempt when the reviewer rejects the change:
// a newer generation from the same family as the coder,
// so the reviewer is still from a different family.
const ESCALATION_MODEL = "gpt-6-luna";

// Shape the reviewer's answer must have. If it does not match, the runtime
// asks for a correction once; if it still does not match, it returns null.
const VERDICT = {
  type: "object",
  required: ["approved", "issues"],
  properties: {
    approved: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
  },
};

const planCodeReview = defineWorkflow({
  meta: {
    name: "plan-code-review",
    description:
      "Plans, implements and reviews a change with a different model in each phase. " +
      "If the review asks for changes, it repeats the implementation with a more capable model. " +
      "args: { task: string }",
    phases: [
      { title: "Plan", detail: "planner agent" },
      { title: "Code", detail: "coder agent" },
      { title: "Review", detail: "reviewer agent, from a different model family" },
      { title: "Escalate", detail: "only if the review asks for changes" },
    ],
    argsSchema: {
      type: "object",
      required: ["task"],
      properties: { task: { type: "string" } },
    },
    // Worst case: plan, code, review, escalated code and a second review,
    // plus one possible retry on each schema-checked review. Total: 7.
    limits: { maxTotalSubagents: 7 },
  },

  run: async (ctx) => {
    const task = String(ctx.args?.task ?? "").trim();
    if (!task) return { error: "Missing args.task" };

    ctx.phase("Plan");
    const request = `Prepare the plan for this task:\n${task}`;
    const plan = await ctx.agent(request,
      { agent: "planner", label: "plan" });
    if (!plan) return { error: "The planner did not return a plan" };

    ctx.phase("Code");
    const assignment = `Implement this plan:\n${plan}`;
    const report = await ctx.agent(assignment,
      { agent: "coder", label: "code" });
    if (!report) return { plan, error: "The coder did not finish" };

    // Each review gets its own label: two identical calls to ctx.agent
    // are memoized and would return the same result.
    let reviews = 0;
    const review = (changes) =>
      ctx.agent(
        `Review this change.\n\nPlan:\n${plan}\n\nCoder's report:\n${changes}\n\n` +
          "Return approved and the list of concrete issues, with file and line.",
        { agent: "reviewer", label: `review-${++reviews}`, schema: VERDICT },
      );

    ctx.phase("Review");
    let verdict = await review(report);
    if (!verdict) return { plan, report, error: "The reviewer did not return a valid verdict" };
    let fix = null;
    let escalated = false;

    if (!verdict.approved) {
      ctx.phase("Escalate");
      escalated = true;
      ctx.log(`The review asks for changes: second attempt with ${ESCALATION_MODEL}.`);
      const correction =
        `Fix these issues without extending the plan:\n${verdict.issues.join("\n")}\n\nPlan:\n${plan}`;
      fix = await ctx.agent(correction, {
        agent: "coder",
        model: ESCALATION_MODEL,
        label: "code-escalated",
      });
      if (!fix) return { plan, report, verdict, escalated, error: "The escalated coder did not finish" };
      verdict = await review(fix);
      if (!verdict) return { plan, report, fix, escalated, error: "The second review did not return a valid verdict" };
    }

    return { plan, report, fix, verdict, escalated };
  },
});

await joinSession({ workflows: [planCodeReview] });

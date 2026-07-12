export function createHarness({ harness, model, callModel, normalizeBrowserTool }) {
  return {
    async runStep(input) {
      const output = await callModel({
        system: [
          'You are running inside lvl through an example custom harness.',
          'Pick one legal chess move from the current observation.',
          'Return JSON only: {"mode":"run","script":"const tab = await browser.currentTab(); await tab.click(\"e2\"); await tab.click(\"e4\"); return await tab.snapshot();"}',
          'Prefer square names like tab.click("e2") and tab.click("e4") when you can infer a legal move.',
          'If context dump is present, use it only as memory; the current legal moves list is authoritative.'
        ].join('\n'),
        observation: input.observation,
        contextDump: input.contextDump,
        abortSignal: input.abortSignal,
        budget: {
          maxTokens: 4096,
          maxToolCalls: input.maxToolCalls,
          timeoutMs: input.timeoutMs
        },
        metadata: {
          runId: input.runId,
          seed: input.seed,
          stepIndex: input.stepIndex,
          modelId: model.id,
          harnessId: harness.id
        }
      });

      return {
        ...output,
        browserTool: normalizeBrowserTool(output.browserTool)
      };
    }
  };
}

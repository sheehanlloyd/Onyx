## Trust, but verify

- **Benchmark Local Models** measures throughput, first-token latency and tool-call compliance for every model — results feed the router.
- After any agent run that edits code, Onyx compares workspace problems against the pre-run baseline.
- Set `onyx.verification.task` to `build` or `test` and Onyx runs your project's own checks after the agent works, posting the verdict to the timeline.

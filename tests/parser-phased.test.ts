/**
 * Tests for phased task format parsing
 * Covers: phase detection, task parsing, phase boundaries, implicit dependencies
 */

import { describe, test, expect } from "bun:test";
import { parseTaskFile } from "../src/parser";
import type { Task } from "../src/types";
import { tempDir, writeTaskFile } from "./helpers";

/** Parse a task file from an inline template literal. */
function parse(content: string) {
	const { dir, cleanup } = tempDir();
	try {
		const filePath = writeTaskFile(dir, "README.md", content);
		return { project: parseTaskFile(filePath), cleanup };
	} catch (e) {
		cleanup();
		throw e;
	}
}

describe("Phased task format", () => {
	describe("Phase detection", () => {
		test("detects phased format with markdown headings", () => {
			const content = `# Voice Conversation

## Phase 1 - MVP
- [ ] 01 - Build voice pipeline
- [ ] 02 - Add audio playback

## Phase 2 - Streaming
- [ ] 03 - WebSocket channel
- [ ] 04 - Streaming STT

## Dependencies
- 02 depends on 01
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases).toBeDefined();
				expect(project.phases?.length).toBe(2);
				expect(project.phases?.[0].number).toBe(1);
				expect(project.phases?.[0].title).toBe("MVP");
				expect(project.phases?.[1].number).toBe(2);
				expect(project.phases?.[1].title).toBe("Streaming");
			} finally {
				cleanup();
			}
		});

		test("detects phased format with plain headings", () => {
			const content = `# Voice Conversation

Phase 1 - MVP
- [ ] 01 - Build voice pipeline
- [ ] 02 - Add audio playback

Phase 2 - Streaming
- [ ] 03 - WebSocket channel

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases).toBeDefined();
				expect(project.phases?.length).toBe(2);
			} finally {
				cleanup();
			}
		});

		test("supports various separators in phase headings", () => {
			const variants = [
				"## Phase 1 - MVP",
				"## Phase 1 - MVP",
				"## Phase 1 - MVP",
				"## Phase 1: MVP",
				"## Phase 1 -  MVP", // multiple spaces
			];

			for (const heading of variants) {
				const content = `# Test

${heading}
- [ ] 01 - Task

## Dependencies
`;
				const { project, cleanup } = parse(content);
				try {
					expect(project.phases).toBeDefined();
					expect(project.phases?.length).toBe(1);
				} finally {
					cleanup();
				}
			}
		});

		test("handles phase headings with extra whitespace", () => {
			const content = `# Test

  ## Phase 1 - MVP
- [ ] 01 - Task

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases).toBeDefined();
				expect(project.phases?.length).toBe(1);
			} finally {
				cleanup();
			}
		});
	});

	describe("Task parsing within phases", () => {
		test("assigns phase number to tasks", () => {
			const content = `# Test

## Phase 1 - MVP
- [ ] 01 - Task A
- [ ] 02 - Task B

## Phase 2 - Enhancement
- [ ] 03 - Task C
- [ ] 04 - Task D

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.tasks[0].id).toBe("01");
				expect(project.tasks[0].phase).toBe(1);
				expect(project.tasks[1].id).toBe("02");
				expect(project.tasks[1].phase).toBe(1);
				expect(project.tasks[2].id).toBe("03");
				expect(project.tasks[2].phase).toBe(2);
				expect(project.tasks[3].id).toBe("04");
				expect(project.tasks[3].phase).toBe(2);
			} finally {
				cleanup();
			}
		});

		test("tracks task IDs in each phase", () => {
			const content = `# Test

## Phase 1 - Foundation
- [ ] 01 - Setup
- [ ] 02 - Config

## Phase 2 - Implementation
- [ ] 03 - Feature A
- [ ] 04 - Feature B
- [ ] 05 - Feature C

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases?.[0].taskIds).toEqual(["01", "02"]);
				expect(project.phases?.[1].taskIds).toEqual(["03", "04", "05"]);
			} finally {
				cleanup();
			}
		});

		test("handles tasks with different statuses in phases", () => {
			const content = `# Test

## Phase 1 - MVP
- [x] 01 - Done task
- [ ] 02 - Pending task
- [~] 03 - In progress

## Phase 2 - Next
- [ ] 04 - Future task

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.tasks[0].status).toBe("completed");
				expect(project.tasks[1].status).toBe("pending");
				expect(project.tasks[2].status).toBe("in_progress");
				expect(project.tasks[3].status).toBe("pending");

				expect(project.phases?.[0].taskIds).toEqual(["01", "02", "03"]);
				expect(project.phases?.[1].taskIds).toEqual(["04"]);
			} finally {
				cleanup();
			}
		});

		test("handles empty phases", () => {
			const content = `# Test

## Phase 1 - Empty

## Phase 2 - Has tasks
- [ ] 01 - Task

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases?.length).toBe(1);
				expect(project.phases?.[0].number).toBe(2);
				expect(project.phases?.[0].taskIds).toEqual(["01"]);
			} finally {
				cleanup();
			}
		});
	});

	describe("Implicit phase-boundary dependencies", () => {
		test("adds dependency from first task of phase 2 to last task of phase 1", () => {
			const content = `# Test

## Phase 1 - MVP
- [ ] 01 - Setup
- [ ] 02 - Build

## Phase 2 - Enhancement
- [ ] 03 - Feature
- [ ] 04 - Test

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				// Task 03 should depend on task 02 (implicit phase boundary)
				expect(
					project.tasks.find((t: Task) => t.id === "03")?.dependencies,
				).toContain("02");
			} finally {
				cleanup();
			}
		});

		test("adds dependencies across multiple phases", () => {
			const content = `# Test

## Phase 1 - Foundation
- [ ] 01 - Setup

## Phase 2 - Core
- [ ] 02 - Build
- [ ] 03 - Test

## Phase 3 — Polish
- [ ] 04 — Refine
- [ ] 05 — Release

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				// Task 02 depends on task 01 (phase 1 → 2 boundary)
				expect(
					project.tasks.find((t: Task) => t.id === "02")?.dependencies,
				).toContain("01");

				// Task 04 depends on task 03 (phase 2 → 3 boundary)
				expect(
					project.tasks.find((t: Task) => t.id === "04")?.dependencies,
				).toContain("03");
			} finally {
				cleanup();
			}
		});

		test("does not duplicate explicit dependencies", () => {
			const content = `# Test

## Phase 1 - MVP
- [ ] 01 - Setup
- [ ] 02 - Build

## Phase 2 — Enhancement
- [ ] 03 — Feature

## Dependencies
- 03 depends on 02
`;
			const { project, cleanup } = parse(content);
			try {
				const task03 = project.tasks.find((t: Task) => t.id === "03");
				const depCount = task03?.dependencies.filter(
					(d: string) => d === "02",
				).length;
				expect(depCount).toBe(1); // Should not duplicate
			} finally {
				cleanup();
			}
		});

		test("handles single phase (no boundaries)", () => {
			const content = `# Test

## Phase 1 - All tasks
- [ ] 01 - Task A
- [ ] 02 - Task B

## Dependencies
`;
			const { project, cleanup } = parse(content);
			try {
				// No implicit dependencies should be added
				expect(project.tasks[0].dependencies).toEqual([]);
				expect(project.tasks[1].dependencies).toEqual([]);
			} finally {
				cleanup();
			}
		});

		test("works alongside explicit dependencies", () => {
			const content = `# Test

## Phase 1 - MVP
- [ ] 01 - Setup
- [ ] 02 - Build

## Phase 2 - Enhancement
- [ ] 03 - Feature A
- [ ] 04 - Feature B

## Dependencies
- 04 depends on 03
`;
			const { project, cleanup } = parse(content);
			try {
				// Task 03 has implicit dependency on task 02
				expect(
					project.tasks.find((t: Task) => t.id === "03")?.dependencies,
				).toContain("02");

				// Task 04 has explicit dependency on task 03
				expect(
					project.tasks.find((t: Task) => t.id === "04")?.dependencies,
				).toContain("03");

				// Task 04 should NOT have implicit dependency on task 02
				expect(
					project.tasks.find((t: Task) => t.id === "04")?.dependencies,
				).not.toContain("02");
			} finally {
				cleanup();
			}
		});
	});

	describe("Mixed formats", () => {
		test("phased format with arrow dependencies", () => {
			const content = `# Test

## Phase 1 - Setup
- [ ] 01 - Initialize
- [ ] 02 - Configure

## Phase 2 - Build
- [ ] 03 - Compile
- [ ] 04 - Bundle

## Dependencies
- 01 → 02
- 03 → 04
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases?.length).toBe(2);
				expect(
					project.tasks.find((t: Task) => t.id === "02")?.dependencies,
				).toContain("01");
				expect(
					project.tasks.find((t: Task) => t.id === "04")?.dependencies,
				).toContain("03");
				expect(
					project.tasks.find((t: Task) => t.id === "03")?.dependencies,
				).toContain("02");
			} finally {
				cleanup();
			}
		});

		test("phased format with parallel groups", () => {
			const content = `# Test

## Phase 1 - MVP
- [ ] 01 - Setup
- [ ] 02 - Build

## Phase 2 - Enhancement
- [ ] 03 - Feature
- [ ] 04 - Test

## Dependencies
- 01, 02 can be done in parallel
- 03, 04 can be done in parallel
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases?.length).toBe(2);
				expect(project.parallelGroups?.length).toBe(2);
				expect(
					project.tasks.find((t: Task) => t.id === "03")?.dependencies,
				).toContain("02");
			} finally {
				cleanup();
			}
		});

		test("phased format with exit criteria", () => {
			const content = `# Test

## Phase 1 - MVP
- [ ] 01 - Build
- [ ] 02 - Test

## Phase 2 - Release
- [ ] 03 - Deploy

## Dependencies

## Exit Criteria
- All tests pass
- Deployment successful
`;
			const { project, cleanup } = parse(content);
			try {
				expect(project.phases?.length).toBe(2);
				expect(project.exitCriteria?.length).toBe(2);
			} finally {
				cleanup();
			}
		});
	});

	describe("Real-world example", () => {
		test("parses voice conversation PRD correctly", () => {
			const content = `# Voice Conversation

Objective: Add full voice conversation capability

## Phase 1 - Push-to-Talk MVP
- [ ] 01 - Build voice pipeline orchestrator → \`01-voice-pipeline-orchestrator.md\`
- [ ] 02 - Build auto-playback audio module → \`02-auto-playback-audio-module.md\`
- [ ] 03 - Wire voice mode toggle into chat UI → \`03-voice-mode-toggle-ui.md\`
- [ ] 04 - End-to-end push-to-talk integration test → \`04-push-to-talk-integration-test.md\`

## Phase 2 - Streaming & Real-Time
- [ ] 05 - Build WebSocket voice channel → \`05-websocket-voice-channel.md\`
- [ ] 06 - Implement streaming STT pipeline → \`06-streaming-stt-pipeline.md\`
- [ ] 07 - Implement streaming TTS pipeline → \`07-streaming-tts-pipeline.md\`

## Phase 3 - Optimization & Hardening
- [ ] 08 - Model quantization and VRAM budget manager → \`08-model-quantization.md\`
- [ ] 09 - Latency profiling and pipeline optimization → \`09-latency-profiling.md\`

## Dependencies
- 02 depends on 01
- 03 depends on 01, 02
- 04 depends on 03
- 06 depends on 05
- 07 depends on 05
- 09 depends on 08

## Exit Criteria
- Users can hold multi-turn voice conversations
- Total round-trip latency under 3s
`;
			const { project, cleanup } = parse(content);
			try {
				// Verify phases
				expect(project.phases?.length).toBe(3);
				expect(project.phases?.[0].title).toBe("Push-to-Talk MVP");
				expect(project.phases?.[1].title).toBe("Streaming & Real-Time");
				expect(project.phases?.[2].title).toBe("Optimization & Hardening");

				// Verify task phases
				expect(project.tasks[0].phase).toBe(1);
				expect(project.tasks[4].phase).toBe(2);
				expect(project.tasks[7].phase).toBe(3);

				// Verify phase boundaries
				// Task 05 (first in phase 2) depends on task 04 (last in phase 1)
				expect(
					project.tasks.find((t: Task) => t.id === "05")?.dependencies,
				).toContain("04");

				// Task 08 (first in phase 3) depends on task 07 (last in phase 2)
				expect(
					project.tasks.find((t: Task) => t.id === "08")?.dependencies,
				).toContain("07");

				// Verify explicit dependencies still work
				expect(
					project.tasks.find((t: Task) => t.id === "02")?.dependencies,
				).toContain("01");
				expect(
					project.tasks.find((t: Task) => t.id === "03")?.dependencies,
				).toContain("01");
				expect(
					project.tasks.find((t: Task) => t.id === "03")?.dependencies,
				).toContain("02");

				// Verify task files
				expect(project.tasks[0].file).toBe("01-voice-pipeline-orchestrator.md");
				expect(project.tasks[1].file).toBe("02-auto-playback-audio-module.md");

				// Verify exit criteria
				expect(project.exitCriteria?.length).toBe(2);
				expect(project.objective).toBe("Voice Conversation");
			} finally {
				cleanup();
			}
		});
	});
});

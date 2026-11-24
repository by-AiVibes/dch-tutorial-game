// The e2e scorer ignores one designed close: the live job stream aborts about 4s after
// the poll says the job is done. Every other network error still fails the step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const E: any = await import("../e2e/lib.mjs" as string);

const STREAM = "/api/jobs/job-issue-goal/stream";
const abort = (route: string, error = "net::ERR_ABORTED") => ({ route, method: "GET", status: 0, error });

test("a stream ERR_ABORTED is ignored only after that job's poll shows done", () => {
  const done = new Set<string>();
  assert.equal(E.finishedStreamAbort(abort(STREAM), done), false, "abort before the poll is done still fails");
  E.noteJobDone({ status: "running" }, "job-issue-goal", done);
  assert.equal(done.has("job-issue-goal"), false, "a running poll is not done");
  assert.equal(E.finishedStreamAbort(abort(STREAM), done), false);
  E.noteJobDone({ status: "error" }, "job-issue-goal", done);
  assert.equal(E.finishedStreamAbort(abort(STREAM), done), false, "an error poll is not done");
  E.noteJobDone({ status: "done" }, "job-issue-goal", done);
  assert.equal(E.finishedStreamAbort(abort(STREAM), done), true);
  assert.equal(E.finishedStreamAbort(abort("https://game.example/api/jobs/job-issue-goal/stream"), done), true, "absolute URL of the same stream");
});

test("any other network error, including an abort of a different URL, still fails", () => {
  const done = new Set(["job-issue-goal"]);
  assert.equal(E.finishedStreamAbort(abort(STREAM, "net::ERR_CONNECTION_RESET"), done), false);
  assert.equal(E.finishedStreamAbort(abort(STREAM, "request failed"), done), false);
  assert.equal(E.finishedStreamAbort(abort("/api/jobs/job-issue-goal"), done), false, "the poll itself aborting is not the stream");
  assert.equal(E.finishedStreamAbort(abort("/api/state"), done), false);
  assert.equal(E.finishedStreamAbort(abort("/api/jobs/other-job/stream"), done), false, "a different job");
  assert.equal(E.finishedStreamAbort({ route: STREAM, method: "GET", status: 500, error: "net::ERR_ABORTED" }, done), false, "an HTTP error is not a designed close");
  assert.equal(E.finishedStreamAbort(abort("/api/jobs/<id>/stream"), done), false, "a masked id cannot be matched");
  E.noteJobDone(null, "job-issue-goal", done);
  E.noteJobDone({ status: "done" }, "", done);
  assert.equal(done.size, 1);
});

test("the e2e scorer uses the poll-done filter and still taps Continue", () => {
  const play = readFileSync(new URL("../e2e/play.mjs", import.meta.url), "utf8");
  assert.match(play, /finishedStreamAbort\(a, jobsDone\)/);
  assert.match(play, /noteJobDone\(/);
  assert.match(play, /data-continue="\$\{s\.cont\}"/);
  assert.match(play, /s\.cont === "run" \|\| s\.cont === "level"/);
});

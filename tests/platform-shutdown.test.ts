import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createShutdownCoordinator, type ShutdownReason } from "../bin/lib/platform.js";

describe("createShutdownCoordinator", () => {
  test("shares concurrent requests and keeps the first reason", async () => {
    const reasons: ShutdownReason[] = [];
    const exits: number[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createShutdownCoordinator({ exit: (code) => exits.push(code) });
    coordinator.setHandler(async (reason) => { reasons.push(reason); await blocked; });

    const signalRun = coordinator.request("SIGTERM");
    const adminRun = coordinator.request("admin");
    assert.equal(adminRun, signalRun);
    assert.deepEqual(reasons, ["SIGTERM"]);
    release();
    await signalRun;

    assert.deepEqual(exits, [0]);
  });

  test("exits after the handler completes", async () => {
    const events: string[] = [];
    const coordinator = createShutdownCoordinator({ exit: () => events.push("exit") });
    coordinator.setHandler(async () => { events.push("handler"); });

    await coordinator.request("admin");

    assert.deepEqual(events, ["handler", "exit"]);
  });

  test("the grace timer exits when the handler hangs", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const exits: number[] = [];
    const coordinator = createShutdownCoordinator({
      exit: (code) => exits.push(code),
      graceMs: 25,
    });
    coordinator.setHandler(() => new Promise<void>(() => {}));

    void coordinator.request("SIGINT");
    t.mock.timers.tick(25);

    assert.deepEqual(exits, [0]);
  });

  test("exits once when the handler finishes after the grace timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const exits: number[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createShutdownCoordinator({
      exit: (code) => exits.push(code),
      graceMs: 25,
    });
    coordinator.setHandler(() => blocked);

    const run = coordinator.request("admin");
    t.mock.timers.tick(25);
    release();
    await run;

    assert.deepEqual(exits, [0]);
  });
});

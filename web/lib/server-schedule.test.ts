import { describe, it, expect, afterEach } from "vitest";
import { serverSyncSchedule } from "./server-schedule";

const ENV = process.env.H2G_SERVER_SYNC_SCHEDULE;
afterEach(() => {
  if (ENV === undefined) delete process.env.H2G_SERVER_SYNC_SCHEDULE;
  else process.env.H2G_SERVER_SYNC_SCHEDULE = ENV;
});

describe("serverSyncSchedule", () => {
  it("is null when unset or blank, so the toggle stays", () => {
    delete process.env.H2G_SERVER_SYNC_SCHEDULE;
    expect(serverSyncSchedule()).toBeNull();
    process.env.H2G_SERVER_SYNC_SCHEDULE = "   ";
    expect(serverSyncSchedule()).toBeNull();
  });

  it("returns the schedule text, trimmed", () => {
    process.env.H2G_SERVER_SYNC_SCHEDULE = " every 2 hours ";
    expect(serverSyncSchedule()).toBe("every 2 hours");
  });
});

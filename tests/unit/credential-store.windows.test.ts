import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createKeyEntry, loadKeyring } from "../../src/personal/credential_store.ts";

const enabled = process.platform === "win32" && process.env["CHEONGEUM_OS_CREDENTIAL_TESTS"] === "1";
const KEY = randomBytes(32).toString("hex");
const services: string[] = [];
const freshService = () => {
  const service = `cheongeum-os-test-${randomBytes(4).toString("hex")}`;
  services.push(service);
  return service;
};

describe.skipIf(!enabled)("Windows credential store with the real library and throwaway names", () => {
  afterAll(() => {
    for (const service of services) {
      for (const target of [service, `data-key.${service}`]) spawnSync("cmd.exe", ["/c", `cmdkey /delete:${target}`]);
    }
  });

  it("stores a key under the service name and keeps it readable across repeated reads", () => {
    const service = freshService();
    expect(createKeyEntry(service, "data-key").getPassword()).toBeNull();
    createKeyEntry(service, "data-key").setPassword(KEY);
    expect(createKeyEntry(service, "data-key").getPassword()).toBe(KEY);
    expect(createKeyEntry(service, "data-key").getPassword()).toBe(KEY);
    expect(loadKeyring().findCredentials(service, service).map(credential => credential.password)).toEqual([KEY]);
  });

  it("adopts a key an earlier build stored under the library default name", () => {
    const service = freshService();
    const keyring = loadKeyring();
    new keyring.Entry(service, "data-key").setPassword(KEY);
    expect(createKeyEntry(service, "data-key").getPassword()).toBe(KEY);
    expect(keyring.findCredentials(service, service).map(credential => credential.password)).toEqual([KEY]);
    expect(createKeyEntry(service, "data-key").legacyPasswords?.()).toEqual([KEY]);
  });

  it("does not create an entry just by looking for one", () => {
    const service = freshService();
    expect(createKeyEntry(service, "data-key").getPassword()).toBeNull();
    expect(loadKeyring().findCredentials(service, service)).toEqual([]);
    expect(new (loadKeyring().Entry)(service, "data-key").getPassword()).toBeNull();
  });
});

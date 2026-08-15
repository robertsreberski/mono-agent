import { describe, expect, it } from "vitest";

import {
  containsVisibleSensitiveText,
  inspectFilesystemRedactionWorkForTest,
  redactJsonValue,
  sanitizeVisibleText,
  truncateString,
} from "../redaction.js";

describe("redactJsonValue", () => {
  it("redacts sensitive keys", () => {
    expect(redactJsonValue({ apiKey: "fixture", token: "fixture", nested: { secret: "x" } })).toEqual({
      apiKey: "[redacted]",
      token: "[redacted]",
      nested: { secret: "[redacted]" },
    });
  });

  it.each([
    "credential",
    "serviceCredentials",
    "CREDENTIAL",
    "private_key",
    "private-key",
    "privateKey",
    "PRIVATE_KEY",
    "client_secret",
    "client-secret",
    "clientSecret",
    "CLIENT_SECRET",
    "encryption_key",
    "encryption-key",
    "encryptionKey",
    "encryptionkey",
    "ENCRYPTION_KEY",
    "database_url",
    "database-url",
    "databaseUrl",
    "databaseurl",
    "DATABASE_URL",
    "bearer",
    "oauthBearer",
    "BEARER",
  ])("redacts the %s key family across common naming styles", (key) => {
    expect(redactJsonValue({ [key]: "fixture-value" })).toEqual({ [key]: "[redacted]" });
  });

  it("does not content-scan free text whose object keys are not sensitive", () => {
    const freeText =
      "credential=fixture private_key=fixture client_secret=fixture authorization=Bearer fixture-value";

    expect(redactJsonValue({ systemPrompt: freeText, userInput: freeText, toolOutput: freeText })).toEqual({
      systemPrompt: freeText,
      userInput: freeText,
      toolOutput: freeText,
    });
  });

  it("keeps numeric values under sensitive-looking keys (token COUNTS, not secrets)", () => {
    // `*_tokens` match /token/ but are usage counts we need for cost observability;
    // secrets are always strings, so only the string token is redacted.
    expect(
      redactJsonValue({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 8,
        credentialCount: 2,
        bearerCount: 1,
        cost_usd: 0.5,
        token: "fixture-value",
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 8,
      credentialCount: 2,
      bearerCount: 1,
      cost_usd: 0.5,
      token: "[redacted]",
    });
  });

  it("keeps generic key and URL fields visible while redacting only credential-bearing compound keys", () => {
    const safe = {
      PUBLIC_KEY: "public-material",
      PRIMARY_KEY: "record-id",
      SORT_KEY: "created-at",
      DOCS_URL: "https://example.com/docs/path",
      url: "postgres://host/db",
      input_tokens: 100,
      outputTokens: 20,
      tokenCount: 2,
    };

    expect(redactJsonValue({
      ...safe,
      fieldEncryptionKey: "encrypt-fixture",
      primaryDatabaseUrl: "postgres://user:password@host/db",
    })).toEqual({
      ...safe,
      fieldEncryptionKey: "[redacted]",
      primaryDatabaseUrl: "[redacted]",
    });
  });

  it("marks circular references as [circular]", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    expect(redactJsonValue(value)).toEqual({ name: "root", self: "[circular]" });
  });

  it("caps recursion at depth 12 with [max-depth]", () => {
    // Build a chain 0..13 deep so the value AT depth 12 is replaced.
    let leaf: Record<string, unknown> = { end: "deep" };
    for (let i = 0; i < 13; i += 1) {
      leaf = { child: leaf };
    }
    const redacted = redactJsonValue(leaf) as Record<string, unknown>;
    // Walk down 12 levels of `child`; the 12th nested value is replaced by the sentinel.
    let cursor: unknown = redacted;
    for (let i = 0; i < 12; i += 1) {
      cursor = (cursor as Record<string, unknown>).child;
    }
    expect(cursor).toBe("[max-depth]");
  });

  it("truncates Error messages through the same string budget", () => {
    const redacted = redactJsonValue(new Error("x".repeat(80)), 16) as { message?: unknown };

    expect(redacted.message).toBe(`${"x".repeat(16)}…[truncated 64 bytes]`);
  });

  it("bounds broad arrays and objects", () => {
    const redacted = redactJsonValue({
      entries: Array.from({ length: 2_000 }, (_, index) => ({ index, value: "x".repeat(4) })),
      object: Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`k${index}`, index])),
    }) as { entries: unknown[]; object: Record<string, unknown> };

    expect(redacted.entries).toHaveLength(1_001);
    expect(redacted.entries.at(-1)).toEqual("[max-items]");
    expect(Object.keys(redacted.object)).toHaveLength(1_001);
    expect(redacted.object.__truncated__).toBe("[max-keys]");
  });

  it("sanitizes object keys without collisions or prototype mutation", () => {
    const macPath = "/Users/example/work/repo/src/a.ts";
    const linuxPath = "/home/example/work/repo/src/a.ts";
    const privatePath = "/Users/example/.ssh/id_rsa";
    const safeOpaqueKey = "[host-path]/src/a.ts";
    const value = Object.fromEntries([
      ["ordinary", "ordinary-value"],
      [safeOpaqueKey, "safe-opaque-value"],
      [macPath, "mac-value"],
      [linuxPath, "linux-value"],
      [privatePath, "private-path-value"],
      ["__proto__", { prototypeValue: "proto-value" }],
      ["constructor", "constructor-value"],
      ["prototype", "prototype-value"],
    ]);
    const options = {
      visibleTextSanitization: { omitFilesystemPaths: true },
    } as const;

    const redacted = redactJsonValue(value, 4_096, options) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    const hostPathEntries = Object.entries(redacted)
      .filter(([key]) => key.startsWith(safeOpaqueKey));

    expect(Object.keys(redacted)).toHaveLength(8);
    expect(redacted.ordinary).toBe("ordinary-value");
    expect(redacted[safeOpaqueKey]).toBe("safe-opaque-value");
    expect(hostPathEntries).toHaveLength(3);
    expect(new Set(hostPathEntries.map(([key]) => key)).size).toBe(3);
    expect(hostPathEntries.map(([, entryValue]) => entryValue)).toEqual(expect.arrayContaining([
      "safe-opaque-value",
      "mac-value",
      "linux-value",
    ]));
    expect(redacted["[private-path]"]).toBe("private-path-value");
    expect(Object.prototype.hasOwnProperty.call(redacted, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(redacted, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(redacted, "prototype")).toBe(true);
    expect(redacted.__proto__).toEqual({ prototypeValue: "proto-value" });
    expect(redacted.constructor).toBe("constructor-value");
    expect(redacted.prototype).toBe("prototype-value");
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(({} as { readonly prototypeValue?: unknown }).prototypeValue).toBeUndefined();
    for (const privateKey of [macPath, linuxPath, privatePath, "/Users/example", "/home/example"]) {
      expect(serialized, privateKey).not.toContain(privateKey);
    }
    expect(redactJsonValue(redacted, 4_096, options)).toEqual(redacted);
  });

  it("redacts high-confidence secret-shaped substrings from plain strings when opted in", () => {
    const fixtures = [
      ["sk", "-", "A".repeat(48)].join(""),
      ["sk", "-proj-", "B".repeat(64)].join(""),
      ["sk", "-svcacct-", "C".repeat(64)].join(""),
      ["ghp", "_", "B".repeat(36)].join(""),
      ["github", "_pat_", "C".repeat(24)].join(""),
      ["AK", "IA", "D".repeat(16)].join(""),
      ["xox", "a-", "E".repeat(24)].join(""),
      ["xox", "b-", "E".repeat(24)].join(""),
      ["xox", "p-", "E".repeat(24)].join(""),
      ["xox", "r-", "E".repeat(24)].join(""),
      ["xox", "s-", "E".repeat(24)].join(""),
      ["xapp", "-1-", "F".repeat(24)].join(""),
    ];
    const prose = `prefix ${fixtures.join(" middle ")} suffix`;

    expect(redactJsonValue(prose, 4_096, { contentPatternRedaction: true })).toBe(
      `prefix ${fixtures.map(() => "[redacted]").join(" middle ")} suffix`,
    );
  });

  it("leaves content scanning disabled by default", () => {
    const fixture = ["sk", "-", "A".repeat(48)].join("");
    expect(redactJsonValue(`plain key: ${fixture}`)).toBe(`plain key: ${fixture}`);
  });

  it("leaves ordinary prefix prose and near-miss token shapes untouched", () => {
    const prose = [
      "The sk- prefix is documented here.",
      "ghp_ is a token-family label.",
      "AKIA is also a personal name.",
      "xoxb- alone is not a credential.",
      "sk-SK-localization-resource-name",
      "sk-NO-translation-catalog-entry",
      "sk-proj-localization-resource-name-for-tests",
      "sk-svcacct-development-profile-name",
      ["sk", "-", "A".repeat(47)].join(""),
      ["sk", "-", "A".repeat(49)].join(""),
      ["ghp", "_", "A".repeat(35)].join(""),
      ["AK", "IA", "B".repeat(15)].join(""),
    ].join(" ");

    expect(redactJsonValue(prose, 4_096, { contentPatternRedaction: true })).toBe(prose);
  });

  it("preserves one stable truncation marker when scanning an already-truncated secret", () => {
    const fixture = ["xox", "b-", "A".repeat(24)].join("");
    const original = `prefix ${fixture} ${"x".repeat(256)}`;
    const truncated = truncateString(original, 64);
    const marker = truncated.slice(truncated.indexOf("…[truncated"));

    const once = redactJsonValue(truncated, 64, { contentPatternRedaction: true }) as string;
    const twice = redactJsonValue(once, 64, { contentPatternRedaction: true }) as string;

    expect(once).toBe(`prefix [redacted] ${"x".repeat(27)}${marker}`);
    expect(once.match(/…\[truncated/gu)).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("applies content-pattern scanning recursively without weakening key redaction", () => {
    const fixture = ["xox", "p-", "A".repeat(24)].join("");
    const redacted =
      redactJsonValue(
        Object.fromEntries([
          ["note", `credential: ${fixture}`],
          ["nested", [`again ${fixture}`]],
          ["apiKey", "not-shape-dependent"],
          [`evidence-${fixture}`, "key-value-survives"],
        ]),
        4_096,
        {
          contentPatternRedaction: true,
          visibleTextSanitization: {},
        },
      ) as Record<string, unknown>;

    expect(redacted).toEqual({
      note: "credential: [redacted]",
      nested: ["again [redacted]"],
      apiKey: "[redacted]",
      "evidence-[redacted]": "key-value-survives",
    });
    expect(JSON.stringify(redacted)).not.toContain(fixture);
  });

  const awsSecretAccessKey = [
    "wJalrXUtnFEMI/K7MDENG/",
    "bPxRfiCYEXAMPLEKEY",
  ].join("");
  const privateKeyHeader = ["-----BEGIN RSA", " PRIVATE KEY-----"].join("");

  it.each([
    "apikey=compact-fixture",
    "APIKEY=upper-fixture",
    "apiKey=camel-fixture",
    "ApiKey=title-camel-fixture",
    "APIKey=acronym-camel-fixture",
    "APIkey=acronym-lower-fixture",
    "myapikey=prefixed-compact-fixture",
    "myApiKey=prefixed-camel-fixture",
    "myAPIKey=prefixed-acronym-camel-fixture",
    "myAPIkey=prefixed-acronym-lower-fixture",
    "openAPIkey=prefixed-open-acronym-fixture",
    "service.api-key=delimited-fixture",
    "service api key=spaced-fixture",
    "'openAPIkey'='quoted-fixture'",
    '"myAPIkey": "colon-fixture"',
  ])("preserves historical API-key assignment redaction for %s", (value) => {
    const options = { omission: "[credential assignment omitted]" } as const;

    expect(containsVisibleSensitiveText(value, options)).toBe(true);
    expect(sanitizeVisibleText(value, options)).toBe(options.omission);
  });

  it.each([
    `AWS_SECRET_ACCESS_KEY=${awsSecretAccessKey}`,
    "awsSecretAccessKey=compact-camel-fixture",
    "awssecretaccesskey=compact-fixture",
    "STRIPE_SECRET_KEY=sk_live_...",
    "stripeSecretKey=compact-camel-fixture",
    "stripesecretkey=compact-fixture",
    `PRIVATE_KEY=${privateKeyHeader}`,
    "SIGNING_PRIVATE_KEY=delimited-fixture",
    "signingPrivateKey=compact-camel-fixture",
    "signingprivatekey=compact-fixture",
    "ENCRYPTION_KEY=<secret>",
    "FIELD_ENCRYPTION_KEY=delimited-fixture",
    "fieldEncryptionKey=compact-camel-fixture",
    "fieldencryptionkey=compact-fixture",
    "DATABASE_URL=postgres://user:password@host/db",
    "PRIMARY_DATABASE_URL=postgres://user:password@host/db",
    "primaryDatabaseUrl=postgres://user:password@host/db",
    "primarydatabaseurl=postgres://user:password@host/db",
  ])("omits high-confidence compound credential assignment %s", (value) => {
    const options = { omission: "[credential assignment omitted]" } as const;

    expect(containsVisibleSensitiveText(value, options)).toBe(true);
    expect(sanitizeVisibleText(value, options)).toBe(options.omission);
  });

  it("bounds a 64 KiB contiguous-uppercase credential assignment", () => {
    const retainedStringBytes = 64 * 1_024;
    const credentialSuffix = "TOKEN=fixture";
    const value = `${"A".repeat(retainedStringBytes - credentialSuffix.length)}${credentialSuffix}`;
    const options = { omission: "[credential assignment omitted]" } as const;

    expect(new TextEncoder().encode(value)).toHaveLength(retainedStringBytes);
    expect(sanitizeVisibleText(value, options)).toBe(options.omission);
  }, 1_000);

  it.each([
    "preauthorization=enabled",
    "accessKeyId=public-identifier",
    "AWS_ACCESS_KEY_ID=AKIAEXAMPLEPUBLICID",
    "PUBLIC_KEY=ssh-rsa-public-material",
    "PRIMARY_KEY=record-id",
    "SORT_KEY=created-at",
    "DOCS_URL=https://example.com/docs/path",
    "WEBHOOK_URL=https://example.com/hooks/receive",
    "https://example.com/docs/private-key-rotation",
    "postgres://host/db",
    "input_tokens=100",
    "token_count=2",
    "apiKeyCount=3",
  ])("preserves non-credential assignment or URL %s", (value) => {
    expect(containsVisibleSensitiveText(value)).toBe(false);
    expect(sanitizeVisibleText(value)).toBe(value);
  });

  it.each([
    ["/Users/example/.mono-agent/artifacts/tool-output/run/output.txt", "[private-path]"],
    ["C:\\Users\\private\\tool-output\\result.txt", "[private-path]"],
    ["Full output saved to: /private/tmp/tool-output.txt", "Full output saved to: [host-path]/tool-output.txt"],
    ["file:///Users/example/repo/src/result.txt", "[host-path]/src/result.txt"],
    ["read ~/private/result.txt", "read [home-path]/private/result.txt"],
  ])("neutralizes only the filesystem span in model-visible text: %s", (value, expected) => {
    const options = {
      omitFilesystemPaths: true,
      omission: "[private host path omitted]",
    } as const;
    expect(containsVisibleSensitiveText(value, options)).toBe(true);
    expect(sanitizeVisibleText(value, options)).toBe(expected);
    expect(redactJsonValue({ output: value }, 4_096, {
      visibleTextSanitization: options,
    })).toEqual({ output: expected });
  });

  it.each([
    ["[/Users/example/.ssh/id_rsa]", "[[private-path]]"],
    ["{/Users/example/private/x.key}", "{[host-path]/private/x.key}"],
    ["x,/Users/example/proj/a.ts", "x,[host-path]/proj/a.ts"],
    ["x;/Users/example/proj/a.ts", "x;[host-path]/proj/a.ts"],
    ["cmd|/Users/example/bin/tool", "cmd|[host-path]/bin/tool"],
    ["user@/Users/example/share", "user@[host-path]/share"],
    ["-->/Users/example/proj/a.ts", "-->[host-path]/proj/a.ts"],
    ["[/Users/example/proj/a.ts](/Users/example/proj/b.ts)", "[[host-path]/proj/a.ts]([host-path]/proj/b.ts)"],
  ])("recognizes a host path after delimiter punctuation: %s", (value, expected) => {
    const options = { omitFilesystemPaths: true } as const;
    expect(containsVisibleSensitiveText(value, options)).toBe(true);
    expect(sanitizeVisibleText(value, options)).toBe(expected);
    expect(sanitizeVisibleText(expected, options)).toBe(expected);
    expect(expected).not.toContain("/Users/example");
  });

  it.each([
    ["/Users/example/a.ts,/Users/example/secret/b.ts", "[host-path]/a.ts,[host-path]/secret/b.ts"],
    ["C:\\Users\\Rob\\a.ts,C:\\Users\\Rob\\secret\\b.ts", "[host-path]/a.ts,[host-path]/secret/b.ts"],
  ])("sanitizes comma-separated paths independently without consuming their separator: %s", (original, expected) => {
    const options = { omitFilesystemPaths: true } as const;

    expect(sanitizeVisibleText(original, options)).toBe(expected);
    expect(sanitizeVisibleText(expected, options)).toBe(expected);
  });

  it.each([
    ["/Users/example/proj/a.ts:42:7", "[host-path]/proj/a.ts:42:7"],
    ["C:\\Users\\Rob\\repo\\src\\a.ts:9:2", "[host-path]/src/a.ts:9:2"],
    ["\\\\server\\share\\Users\\Rob\\repo\\src\\a.ts", "[host-path]/src/a.ts"],
    ["file:///Users/example/repo/src/a.ts", "[host-path]/src/a.ts"],
    ["file://build-host/Users/example/repo/src/a.ts", "[host-path]/src/a.ts"],
    ["/home/example/.aws/credentials", "[private-path]"],
    ["C:\\Users\\Rob\\.mono-agent\\artifacts\\tool-output\\run-1\\out.txt", "[private-path]"],
    ["gcc -I/Users/example/repo/include", "gcc -I[host-path]/repo/include"],
    ["tar -C/Users/example/archive source.tgz", "tar -C[host-path]/archive source.tgz"],
    ["docker -v/Users/example/data:/data image", "docker -v[host-path]/data:/data image"],
    ["rsync -av/Users/example/source target", "rsync -av[host-path]/source target"],
    ["read ~rob/repo/src/a.ts", "read [home-path]/src/a.ts"],
    [".../Users/example/repo/src/a.ts", "...[host-path]/src/a.ts"],
    ["/Users/example/Users/example", "[host-path]"],
    ["[host-path]/Users/example/repo/src/a.ts", "[host-path]/src/a.ts"],
    ["[private-path]/etc/passwd", "[private-path]/etc/passwd"],
    ["[private-path]/Users/example/repo/a.ts", "[private-path][host-path]/repo/a.ts"],
    [".ssh/id_rsa", "[private-path]"],
    [".aws/credentials", "[private-path]"],
    ["/Users/example/.git-credentials", "[private-path]"],
    ["~rob/.netrc", "[private-path]"],
    ["/home/example/.npmrc", "[private-path]"],
  ])("handles supported host-path forms and private segments: %s", (value, expected) => {
    const options = { omitFilesystemPaths: true } as const;
    expect(sanitizeVisibleText(value, options)).toBe(expected);
    expect(sanitizeVisibleText(expected, options)).toBe(expected);
  });

  it.each([
    ["/users/example/.git-credentials", "[private-path]"],
    ["/Home/example/.npmrc", "[private-path]"],
    ["/USERS/example/repo/src/a.ts", "[host-path]/src/a.ts"],
  ])("case-folds POSIX roots and strips private account segments: %s", (value, expected) => {
    const options = { omitFilesystemPaths: true } as const;
    const sanitized = sanitizeVisibleText(value, options);

    expect(sanitized).toBe(expected);
    expect(sanitized).not.toMatch(/\/example(?:\/|$)/iu);
    expect(sanitizeVisibleText(sanitized, options)).toBe(sanitized);
  });

  it.each([
    "https://example.com/Users/example/a.ts,/Users/example/still-url.ts",
    "custom+scheme://host/Users/example/a.ts;segment/Users/example/b.ts",
    "https://example.com/Users/example/.ssh/url_rsa?next=/Users/example/.aws/url-credentials#fragment",
    "[URL](https://example.com/Users/example/a.ts)",
    "//example.com/Users/example/a.ts",
    "//example.com/Users/example/.ssh/url_rsa",
  ])("does not treat URL path components as host filesystem paths: %s", (value) => {
    const options = { omitFilesystemPaths: true } as const;
    expect(containsVisibleSensitiveText(value, options)).toBe(false);
    expect(sanitizeVisibleText(value, options)).toBe(value);
  });

  it.each([
    "<div>content</div>",
    "<Users>content</Users>",
    "</session_tool_history>",
    "3 / 4",
    "use / as the separator",
    "build/run/test and alpha/Users/example",
    "/^foo$/giu",
    "replace /^foo$/ with bar /g",
    "GET /api/v1/users?active=true HTTP/1.1",
    "POST /request/path HTTP/1.1",
    "/public/assets/app.js",
    "/docs/reference/session-history",
  ])("preserves useful slash syntax and public request paths: %s", (value) => {
    const options = { omitFilesystemPaths: true } as const;

    expect(containsVisibleSensitiveText(value, options)).toBe(false);
    expect(sanitizeVisibleText(value, options)).toBe(value);
  });

  const reviewerAccount = ["roberts", "reberski"].join("");
  const reviewerMacHome = ["/Users", reviewerAccount].join("/");
  const reviewerLinuxHome = ["/home", reviewerAccount].join("/");

  it.each([
    [
      `GET ${reviewerMacHome}/notes.txt HTTP/1.1`,
      "GET [host-path]/notes.txt HTTP/1.1",
    ],
    [
      `GET /files?path=${reviewerMacHome}/notes.txt HTTP/1.1`,
      "GET /files?path=[host-path]/notes.txt HTTP/1.1",
    ],
    [
      `POST /upload?dest=${reviewerLinuxHome}/secret-project/plan.md HTTP/1.0`,
      "POST /upload?dest=[host-path]/secret-project/plan.md HTTP/1.0",
    ],
    [
      `GET /api/v1/users?path=${reviewerMacHome}/notes.txt HTTP/1.1`,
      "GET /api/v1/users?path=[host-path]/notes.txt HTTP/1.1",
    ],
    [
      "GET /Users/example/.ssh/id_rsa HTTP/1.1",
      "GET [private-path] HTTP/1.1",
    ],
    [
      "GET /api/read?file=/Users/example/.ssh/id_rsa HTTP/1.1",
      "GET /api/read?file=[private-path] HTTP/1.1",
    ],
    [
      "GET /Users/example/profile?file=.ssh/id_rsa HTTP/1.1",
      "GET [host-path]/profile?file=[private-path] HTTP/1.1",
    ],
  ])("redacts filesystem-shaped host evidence inside an HTTP request target: %s", (value, expected) => {
    const options = { omitFilesystemPaths: true } as const;

    expect(containsVisibleSensitiveText(value, options)).toBe(true);
    expect(sanitizeVisibleText(value, options)).toBe(expected);
  });

  it("does not invent a token or line start at the bounded lookbehind edge", () => {
    const oversizedOption = `-${"I".repeat(64)}/Users/example/profile`;
    const oversizedRequestPrefix = `GET${" ".repeat(64)}/Users/example/profile HTTP/1.1`;
    const options = { omitFilesystemPaths: true } as const;

    expect(sanitizeVisibleText(oversizedOption, options)).toBe(oversizedOption);
    expect(sanitizeVisibleText(oversizedRequestPrefix, options)).toBe(
      `GET${" ".repeat(64)}[host-path]/profile HTTP/1.1`,
    );
  });

  it("keeps path-classifier slice allocation bounded for a 200 KiB Write-style argument", () => {
    const contentBytes = 200 * 1_024;
    const base64LikeUnit = `${"A".repeat(80)}/`;
    const content = base64LikeUnit.repeat(Math.ceil(contentBytes / base64LikeUnit.length))
      .slice(0, contentBytes);
    const serialized = JSON.stringify({
      tool: "Write",
      arguments: {
        file_path: "/users/PrivateAccount/repo/blob.bin",
        content,
      },
    });
    const work = inspectFilesystemRedactionWorkForTest(serialized);

    expect(serialized.length).toBeGreaterThanOrEqual(contentBytes);
    expect(work.sanitized).toContain('"file_path":"[host-path]/repo/blob.bin"');
    expect(sanitizeVisibleText(serialized, { omitFilesystemPaths: true }))
      .toContain('"file_path":"[host-path]/repo/blob.bin"');
    expect(work.largestSliceCodeUnits).toBeLessThanOrEqual(128);
    expect(work.slicedCodeUnits).toBeLessThanOrEqual(serialized.length * 2);
    expect(work.scannerIterations + work.urlSchemeCodeUnits).toBeLessThanOrEqual(serialized.length * 2);

    const redacted = redactJsonValue(
      { file_path: "/users/PrivateAccount/repo/blob.bin", content },
      4_096,
      { visibleTextSanitization: { omitFilesystemPaths: true } },
    ) as { readonly file_path: string; readonly content: string };
    expect(redacted.file_path).toBe("[host-path]/repo/blob.bin");
    expect(redacted.content).toMatch(/…\[truncated \d+ bytes\]$/u);
  });

  it("keeps URL-scheme classification work linear on plus-dense input", () => {
    const countClassificationWork = (codeUnits: number): number => {
      const input = "a+".repeat(codeUnits / 2);
      const work = inspectFilesystemRedactionWorkForTest(input);
      expect(work.sanitized).toBe(input);
      expect(sanitizeVisibleText(input, {
        omitFilesystemPaths: true,
        maxBytes: codeUnits,
      })).toBe(input);
      return work.scannerIterations + work.urlSchemeCodeUnits;
    };

    const sizes = [512, 1_024, 2_048] as const;
    const counts = sizes.map(countClassificationWork);

    expect(counts[1]).toBeLessThanOrEqual(counts[0]! * 2.5);
    expect(counts[2]).toBeLessThanOrEqual(counts[1]! * 2.5);
    expect(counts[2]).toBeLessThanOrEqual(sizes[2] * 2);
  });

  it.each([
    ["./src/a.ts", "./src/a.ts"],
    ["../src/b.ts", "../src/b.ts"],
    [".\\src\\c.ts", ".\\src\\c.ts"],
    ["..\\src\\d.ts", "..\\src\\d.ts"],
    ["~/repo/src/e.ts", "[home-path]/src/e.ts"],
    ["~/.ssh/id_rsa", "[private-path]"],
  ])("applies the explicit portable-relative versus home-relative policy: %s", (original, expected) => {
    const options = { omitFilesystemPaths: true } as const;

    expect(sanitizeVisibleText(original, options)).toBe(expected);
    expect(sanitizeVisibleText(expected, options)).toBe(expected);
  });

  it("keeps commands, multiple path suffixes, punctuation, line/column data, and web URLs inspectable", () => {
    const original = [
      "Read /Users/example/work/repo/src/index.ts:42:7),",
      "compare C:\\Users\\Alice\\repo\\src\\windows.ts:9:2;",
      "then ls -la /etc && open https://example.com/docs/path.",
    ].join(" ");
    const sanitized = sanitizeVisibleText(original, { omitFilesystemPaths: true });

    expect(sanitized).toBe([
      "Read [host-path]/src/index.ts:42:7),",
      "compare [host-path]/src/windows.ts:9:2;",
      "then ls -la [host-path]/etc && open https://example.com/docs/path.",
    ].join(" "));
    expect(sanitized).not.toContain("/Users/example");
    expect(sanitized).not.toContain("C:\\Users\\Alice");
  });

  it("composes recursive path neutralization, credential redaction, truncation bounds, and repeat passes", () => {
    const secret = ["sk", "-", "A".repeat(48)].join("");
    const value = {
      read: { file_path: "/Users/example/work/repo/src/index.ts", apiKey: "not-shape-dependent" },
      nested: [
        "stack at /home/example/service/src/worker.ts:12:4",
        { command: `cat /repo/config.json and report ${secret}` },
      ],
      url: "https://example.com/a/b",
    };
    const options = {
      contentPatternRedaction: true,
      visibleTextSanitization: { omitFilesystemPaths: true },
    } as const;
    const once = redactJsonValue(value, 4_096, options);
    const twice = redactJsonValue(once, 4_096, options);

    expect(once).toEqual({
      read: { file_path: "[host-path]/src/index.ts", apiKey: "[redacted]" },
      nested: [
        "stack at [host-path]/src/worker.ts:12:4",
        { command: "cat [host-path]/repo/config.json and report [redacted]" },
      ],
      url: "https://example.com/a/b",
    });
    expect(twice).toEqual(once);

    const bounded = sanitizeVisibleText(
      `inspect /Users/example/work/repo/src/index.ts ${"x".repeat(500)}`,
      { omitFilesystemPaths: true, maxBytes: 64 },
    );
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(64);
    expect(bounded).toContain("[host-path]/src/index.ts");
    expect(bounded).not.toContain("/Users/example");
    expect(sanitizeVisibleText(bounded, { omitFilesystemPaths: true, maxBytes: 64 })).toBe(bounded);
  });

  it("keeps whole-value omission for explicitly private run-artifact evidence", () => {
    const artifactDir = "/Users/example/.mono-agent/artifacts/runs";
    expect(sanitizeVisibleText(`inspect ${artifactDir}/run-1.summary.json`, {
      artifactDir,
      omitFilesystemPaths: true,
      omission: "[private artifact omitted]",
    })).toBe("[private artifact omitted]");
  });

  it("does not mistake web URLs, ordinary repository-relative paths, or exact redaction sentinels for host evidence", () => {
    const options = { omitFilesystemPaths: true } as const;
    for (const value of [
      "https://example.com/docs/path",
      "inspect src/runtime/index.ts",
      "read ./src/runtime/index.ts and ../shared/types.ts",
      "token=[redacted]",
      "password: '[redacted]'",
    ]) {
      expect(containsVisibleSensitiveText(value, options), value).toBe(false);
      expect(sanitizeVisibleText(value, options)).toBe(value);
    }
  });
});

describe("truncateString", () => {
  it("returns the value unchanged at the maxStringBytes boundary", () => {
    const value = "a".repeat(64);
    expect(truncateString(value, 64)).toBe(value);
  });

  it("truncates one byte past the boundary with the UTF-8 byte count", () => {
    const value = "a".repeat(65);
    // Prior implementation used Buffer.byteLength(value, "utf8") === 65.
    expect(truncateString(value, 64)).toBe(`${value.slice(0, 64)}…[truncated 1 bytes]`);
  });

  it("keeps the retained text within the byte cap for multi-byte input (no split code points)", () => {
    // "😀" is 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes.
    const emoji = "😀".repeat(20); // 80 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(emoji).length).toBe(80);

    const out = truncateString(emoji, 64);
    const head = out.split("…[truncated")[0]!;
    // The kept head must not exceed the cap...
    expect(encoder.encode(head).length).toBeLessThanOrEqual(64);
    // ...and must remain whole emoji (4-byte boundary), not a split code point.
    expect(head).toBe("😀".repeat(16)); // 16 * 4 = 64 bytes
    expect(out).toBe(`${"😀".repeat(16)}…[truncated 16 bytes]`);
  });

  it("cuts CJK input on a UTF-8 boundary at or below the byte cap", () => {
    // Each CJK char is 3 UTF-8 bytes; 64 is not a multiple of 3.
    const cjk = "観".repeat(30); // 90 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(cjk).length).toBe(90);

    const out = truncateString(cjk, 64);
    const head = out.split("…[truncated")[0]!;
    // 21 chars = 63 bytes is the largest whole-character cut at or below 64.
    expect(encoder.encode(head).length).toBe(63);
    expect(encoder.encode(head).length).toBeLessThanOrEqual(64);
    expect(out).toBe(`${"観".repeat(21)}…[truncated 27 bytes]`);
  });

  it("preserves its canonical omitted-byte marker across repeated boundaries", () => {
    const once = truncateString("x".repeat(100_000), 4_096);
    const multibyteOnce = truncateString("観".repeat(100_000), 4_096);

    expect(once).toBe(`${"x".repeat(4_096)}…[truncated 95904 bytes]`);
    expect(truncateString(once, 4_096)).toBe(once);
    expect(multibyteOnce).toBe(`${"観".repeat(1_365)}…[truncated 295905 bytes]`);
    expect(truncateString(multibyteOnce, 4_096)).toBe(multibyteOnce);
  });

  it("does not trust a marker whose claimed original value fit within the boundary", () => {
    const impossibleMarker = `${"x".repeat(4_093)}…[truncated 1 bytes]`;

    expect(truncateString(impossibleMarker, 4_096)).toBe(
      `${"x".repeat(4_093)}……[truncated 19 bytes]`,
    );
  });
});

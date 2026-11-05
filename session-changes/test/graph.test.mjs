import { test } from "node:test";
import assert from "node:assert/strict";
import { addedIdentifiers, isNoise, isSecret, jiraKeys, layerOf, relate, relationsOf, submodulesOf } from "../mods/session-changes/graph.js";

test("names decide db and tests before any file votes", () => {
  assert.equal(layerOf("shop-db", ["src/Thing.cs"]), "db");
  assert.equal(layerOf("e2e-tests", ["envs/backoffice.yaml"]), "tests");
});

test("source files outvote the tests an agent wrote beside them", () => {
  const paths = ["src/Antares.Api/Controllers/BetController.cs", "tests/A/BetFeature.cs", "tests/A/B.cs", "tests/A/C.cs"];
  assert.equal(layerOf("checkout-api", paths), "api");
  assert.equal(layerOf("storefront", ["src/pages/Bets.vue", "src/pages/Bets.spec.ts"]), "ui");
  assert.equal(layerOf("payments", ["Payments/gRPCEndPoints/BetInfoGrpcEndPoint.cs", "Payments/Services/S.cs"]), "service");
});

test("only tests changed means the tests layer; nothing votable means other", () => {
  assert.equal(layerOf("payments", ["tests/A/BetFeature.cs"]), "tests");
  assert.equal(layerOf("docs", ["README.md"]), "other");
});

test("a repo with nothing votable falls back to words in its name", () => {
  assert.equal(layerOf("shop-sdk", ["README.md"]), "sdk");
  assert.equal(layerOf("shop-gateway", ["README.md"]), "api");
  assert.equal(layerOf("shop-frontend", ["README.md"]), "ui");
  assert.equal(layerOf("shop-database", ["README.md"]), "db");
  assert.equal(layerOf("shop-migrations", ["src/Thing.cs"]), "db");
  assert.equal(layerOf("loadtest", ["src/Thing.cs"]), "tests");
  assert.equal(layerOf("shop-api", ["src/Thing.cs"]), "service");
});

test("lockfiles and generated files are noise, env files and keys are secret", () => {
  assert.ok(isNoise("package-lock.json") && isNoise("src/Resources.Designer.cs"));
  assert.ok(!isNoise("src/Bets.vue"));
  assert.ok([".env", "app/.env.local", "certs/server.pem", "config/secrets.json", "id_rsa"].every(isSecret));
  assert.ok(!isSecret("src/environment.ts"));
});

test("config and credential files beyond .env are secret too", () => {
  const secret = [
    "src/Api/appsettings.json", "src/Api/appsettings.Production.json", "infra/prod.tfvars", "infra/terraform.tfstate", "home/.pgpass",
    "home/.aws/credentials", "home/.kube/kubeconfig", "ops/service-account-prod.json", "home/.git-credentials", "web/.htpasswd",
  ];
  for (const path of secret) assert.ok(isSecret(path), path);
  for (const path of ["src/Credentials.cs", "docs/credentials-guide.md", "src/appsettings.cs"]) assert.ok(!isSecret(path), path);
});

test("only multi-word names from added lines of non-noise files count", () => {
  const diff = [
    "+++ b/src/Bet.cs",
    "+public string WalletCurrency { get; set; } // Currency",
    "-public string OldThing_Name;",
    "+await x.ToListAsync(cancellationToken);",
    "+++ b/package-lock.json",
    '+"someLockEntry": 1',
  ].join("\n");
  assert.deepEqual(addedIdentifiers(diff), ["walletcurrency"]);
});

const repo = (name, extra = {}) => ({ name, files: [], subjects: [], idents: [], submodules: [], ...extra });
const layers = { "shop-db": "db", payments: "service", storefront: "ui", "e2e-tests": "tests" };
const layer = (n) => layers[n] ?? "other";

test("a shared Jira key links repos, pointing down the layers", () => {
  const edges = relate([repo("storefront", { subjects: ["feat: bets SHOP-5451"] }), repo("shop-db", { subjects: ["SHOP-5451 sp"] })], layer);
  assert.deepEqual(edges, [{ from: "shop-db", to: "storefront", kind: "jira", labels: ["SHOP-5451"] }]);
});

test("a submodule pointer links repos with no shared names", () => {
  const subs = submodulesOf('[submodule "external/storefront"]\n\tpath = external/storefront\n\turl = git@example.com:acme/storefront.git\n');
  assert.deepEqual(subs, ["storefront"]);
  const edges = relate([repo("e2e-tests", { submodules: subs }), repo("storefront")], layer);
  assert.deepEqual(edges.map((e) => [e.from, e.to, e.kind]), [["storefront", "e2e-tests", "submodule"]]);
});

test("one short shared name is not enough for an identifier edge, one long one is", () => {
  assert.deepEqual(relate([repo("payments", { idents: ["usdtrate"] }), repo("storefront", { idents: ["usdtrate"] })], layer), []);
  const edges = relate([repo("payments", { idents: ["walletcurrency"] }), repo("storefront", { idents: ["walletcurrency"] })], layer);
  assert.equal(edges[0].kind, "ident");
});

test("a stronger link replaces a weaker one between the same pair", () => {
  const both = { subjects: ["SHOP-1"], idents: ["walletcurrency"] };
  const edges = relate([repo("payments", both), repo("storefront", both)], layer);
  assert.deepEqual(edges.map((e) => e.kind), ["jira"]);
});

test("relations list downstream targets once per shared label", () => {
  const edges = [
    { from: "shop-db", to: "payments", kind: "jira", labels: ["SHOP-5451"] },
    { from: "shop-db", to: "storefront", kind: "jira", labels: ["SHOP-5451"] },
    { from: "shop-db", to: "storefront", kind: "ident", labels: ["walletcurrency"] },
    { from: "payments", to: "shop-db", kind: "jira", labels: ["SHOP-1"] },
  ];
  assert.deepEqual(relationsOf(edges, "shop-db"), [
    { kind: "jira", label: "SHOP-5451", targets: ["payments", "storefront"] },
    { kind: "ident", label: "walletcurrency", targets: ["storefront"] },
  ]);
});

test("jira keys come out sorted and unique", () => {
  assert.deepEqual(jiraKeys(["SHOP-2 a", "fix SHOP-10", "SHOP-2 b"]), ["SHOP-10", "SHOP-2"]);
});

test("a path-based noise rule can be skipped for a file the session owns, but name-based ones cannot", () => {
  assert.ok(isNoise("bin/deploy.sh") && isNoise("src/obj/x.dll") && isNoise("web/dist/app.js"));
  assert.ok(!isNoise("bin/deploy.sh", { owned: true }) && !isNoise("web/dist/app.js", { owned: true }));
  assert.ok(isNoise("package-lock.json", { owned: true }) && isNoise("src/Res.Designer.cs", { owned: true }) && isNoise("app.min.js", { owned: true }));
});

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startUIEnvironment } from "../tests/ui-environment.ts";

let environment: Awaited<ReturnType<typeof startUIEnvironment>>;
test.beforeAll(async () => { environment = await startUIEnvironment(); });
test.afterAll(async () => { await environment?.stop(); });
async function openTools(page: Page) {
  const toggle = page.getByRole("button", { name: "Pengaturan workbook", exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
}
async function login(page: Page, email = environment.users[0]!) {
  await page.goto(environment.baseURL);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Kata sandi", { exact: true }).fill(environment.password);
  const loginResponse = page.waitForResponse(response => response.url().endsWith("/api/session") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  const result = await loginResponse; expect(result.ok(), "Login response: " + JSON.stringify(await result.json())).toBe(true);
  await expect(page.getByText("Sesi aktif", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Status operasi", exact: true })).not.toHaveText("Memproses…");
  await openTools(page);
}
async function createWorkbook(page: Page, analysis = "Analysis sintetis") {
  await page.getByLabel("Nama proyek baru", { exact: true }).fill("Proyek sintetis Fase 5");
  await page.getByLabel("Nama Analysis", { exact: true }).fill(analysis);
  await page.getByRole("button", { name: "Buat workbook kosong" }).click();
  await expect(page.getByRole("heading", { name: `Proyek sintetis Fase 5 / ${analysis}`, exact: true })).toBeVisible();
}
async function addField(page: Page, name: string, stage: string, value = "", expression = "") {
  await page.getByLabel("Tahap", { exact: true }).selectOption(stage);
  await page.getByLabel("Nama field", { exact: true }).fill(name);
  await page.getByLabel("Input awal", { exact: true }).fill(value);
  await page.getByLabel("Formula (opsional, gunakan referensi stable ID)", { exact: true }).fill(expression);
  await page.getByRole("button", { name: "Tambah field", exact: true }).click();
  const reference = await page.getByRole("article", { name: "Field " + name, exact: true }).locator("code").first().innerText();
  expect(reference).toMatch(/^@\{[\da-f-]+\}$/);
  return reference;
}
async function configure(page: Page, units: Record<string, string>) {
  await page.getByLabel("Skala desimal", { exact: true }).fill("4");
  await page.getByLabel("Pembulatan", { exact: true }).selectOption("HALF_UP");
  for (const [label, unit] of Object.entries(units)) await page.getByLabel("Satuan " + label, { exact: true }).selectOption(unit);
  await page.getByRole("button", { name: "Terapkan konfigurasi preview" }).click();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("status", { name: "Status operasi", exact: true })).toHaveText(/Draft (dan preview )?tersimpan\./);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
}

test("procurement via UI: multi-vendor, negotiation, pinned mapping, AHS profit/loss, reload, conflicts, restore, user isolation and restart", async ({ page, browser }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  await login(page); await createWorkbook(page);
  for (const [vendor, price] of [["Vendor A", "20000"], ["Vendor B", "20500"], ["Vendor C", "21000"]]) {
    await page.getByLabel("Nama vendor", { exact: true }).fill(vendor!);
    await page.getByRole("button", { name: "Tambah vendor", exact: true }).click();
    await page.getByLabel("Vendor", { exact: true }).selectOption({ label: vendor! });
    await page.getByLabel("Nama penawaran", { exact: true }).fill("Penawaran " + vendor!.slice(-1));
    await page.getByRole("button", { name: "Tambah penawaran", exact: true }).click();
    await page.getByLabel("Penawaran", { exact: true }).selectOption({ label: vendor + " / Penawaran " + vendor!.slice(-1) });
    await page.getByLabel("Komponen revisi baru (nama: nilai, satu per baris)", { exact: true }).fill("Harga dasar: " + price);
    await page.getByRole("button", { name: "Tambah revisi / negosiasi" }).click();
  }
  await page.getByLabel("Revisi penawaran terpilih", { exact: true }).selectOption({ label: "Vendor A / Penawaran A / revisi 1" });
  const pinnedRevision = await page.getByLabel("Revisi penawaran terpilih", { exact: true }).inputValue();
  await page.getByLabel("Penawaran", { exact: true }).selectOption({ label: "Vendor A / Penawaran A" });
  await page.getByLabel("Komponen revisi baru (nama: nilai, satu per baris)", { exact: true }).fill("Harga dasar: 19000");
  await page.getByRole("button", { name: "Tambah revisi / negosiasi" }).click();
  await expect(page.getByLabel("Revisi penawaran terpilih", { exact: true })).toHaveValue(pinnedRevision);

  await addField(page, "Supplier S", "KONVERSI_JAGAD");
  await addField(page, "Biaya B", "KONVERSI_JAGAD", "21000");
  const sale = await addField(page, "Harga jual", "AHS", "26000");
  const volume = await addField(page, "Volume", "AHS", "100");
  const hpp = await page.getByLabel("HPP manual INU", { exact: true }).locator("..").locator("..").locator("code").innerText();
  const revenue = await addField(page, "Pendapatan sintetis", "AHS", "", `${sale}*${volume}`);
  const cost = await addField(page, "Biaya AHS sintetis", "AHS", "", `${hpp}*${volume}`);
  await addField(page, "Laba AHS sintetis", "AHS", "", `${revenue}-${cost}`);
  await page.getByLabel("HPP manual INU", { exact: true }).fill("20000");
  await configure(page, { "HPP manual INU": "IDR/L", "HPP manual SOLAR_BAWAH": "IDR/L", "Supplier S": "IDR/L", "Biaya B": "IDR/L", "Harga jual": "IDR/L", Volume: "L", "Pendapatan sintetis": "IDR", "Biaya AHS sintetis": "IDR", "Laba AHS sintetis": "IDR" });
  await page.getByLabel("Komponen terpilih", { exact: true }).selectOption({ label: "Harga dasar" });
  await page.getByLabel("Target Konversi", { exact: true }).selectOption({ label: "Supplier S" });
  await page.getByLabel("Alasan mapping", { exact: true }).fill("Skenario sintetis; O dan S memakai IDR/L yang sama");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Aktifkan mapping preview" }).click();
  await expect(page.getByLabel("Hasil Supplier S", { exact: true })).toHaveText("20000");
  await expect(page.getByLabel("Hasil Laba AHS sintetis", { exact: true })).toHaveText("600000");
  await page.getByLabel("Alasan perubahan", { exact: true }).fill("Baseline sintetis tiga vendor dan negosiasi");
  await save(page);
  const analysisURL = page.url(), originalRevision = await page.getByTestId("revision-id").innerText();
  await page.getByTestId("procurement-sheet").screenshot({ path: test.info().outputPath("worksheet-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel("Lembar procurement", { exact: true }).screenshot({ path: test.info().outputPath("worksheet-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await openTools(page);
  await expect(page.getByLabel("Hasil Laba AHS sintetis", { exact: true })).toHaveText("600000");
  await expect(page.getByLabel("Revisi penawaran terpilih", { exact: true })).toHaveValue(pinnedRevision);

  // A second tab holds the old head while the first saves a loss scenario.
  const staleTab = await page.context().newPage(); await staleTab.goto(analysisURL);
  await openTools(staleTab);
  await expect(staleTab.getByLabel("HPP manual INU", { exact: true })).toHaveValue("20000");
  await page.getByLabel("HPP manual INU", { exact: true }).fill("28000");
  await expect(page.getByLabel("Hasil Laba AHS sintetis", { exact: true })).toHaveText("-200000");
  await page.getByLabel("Profil", { exact: true }).selectOption("SOLAR_BAWAH");
  await page.getByLabel("HPP manual SOLAR_BAWAH", { exact: true }).fill("18000");
  await page.getByLabel("Profil", { exact: true }).selectOption("INU");
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveValue("28000");
  await save(page);
  await staleTab.getByLabel("HPP manual INU", { exact: true }).fill("22000");
  await staleTab.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(staleTab.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Revisi sudah berubah");
  await expect(staleTab.getByLabel("HPP manual INU", { exact: true })).toHaveValue("22000");
  staleTab.on("dialog", dialog => dialog.accept()); await staleTab.close();
  await page.reload();
  await openTools(page);
  await expect(page.getByLabel("Hasil Laba AHS sintetis", { exact: true })).toHaveText("-200000");
  await page.getByRole("button", { name: "Restore revisi 1", exact: true }).click();
  await expect(page.getByRole("status", { name: "Status operasi", exact: true })).toHaveText("Restore tersimpan sebagai revisi baru.");
  await expect(page.getByTestId("revision-id")).not.toHaveText(originalRevision);
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveValue("20000");
  await expect(page.getByText("3 revisi · 2 run kalkulasi", { exact: true })).toBeVisible();
  await save(page);
  await expect(page.getByLabel("Hasil Laba AHS sintetis", { exact: true })).toHaveText("600000");
  await page.getByRole("button", { name: "Finalisasi", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Finalisasi belum tersedia");

  // User B uses a genuinely separate Auth/browser session and attempts the same UI URL.
  const contextB = await browser.newContext(); const pageB = await contextB.newPage();
  await login(pageB, environment.users[1]!);
  await expect(pageB.getByLabel("Proyek tersimpan", { exact: true }).locator("option")).toHaveCount(1);
  await pageB.goto(analysisURL);
  await expect(pageB.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Data tidak ditemukan");
  await expect(pageB.getByLabel("HPP manual INU", { exact: true })).toHaveCount(0);
  await contextB.close();

  await environment.restartApp(); await page.reload();
  await openTools(page);
  await expect(page.getByLabel("Hasil Laba AHS sintetis", { exact: true })).toHaveText("600000");
  await expect(page.getByText("4 revisi · 3 run kalkulasi", { exact: true })).toBeVisible();
  const rows = await environment.sql`select count(*)::int as count from procurement.revisions`;
  expect(rows[0]!.count).toBe(4);
  expect(consoleErrors).toEqual([]);
});

test("changing accounts in another tab hides the previous user's draft", async ({ page }) => {
  await login(page); await createWorkbook(page, "Draft privat sintetis");
  await page.getByLabel("HPP manual INU", { exact: true }).fill("777");
  const sibling = await page.context().newPage(); await sibling.goto(environment.baseURL);
  await expect(sibling.getByText("Sesi aktif", { exact: true })).toBeVisible();
  await sibling.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Masuk", exact: true })).toBeVisible();
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(environment.users[1]!);
  await page.getByLabel("Kata sandi", { exact: true }).fill(environment.password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByText("Sesi aktif", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proyek sintetis Fase 5 / Draft privat sintetis", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveCount(0);
  await sibling.close();
});

test("UI validation, loading, safe storage errors, same-mutation retry, refresh and sign-out", async ({ page }) => {
  await page.goto(environment.baseURL);
  await page.getByLabel("Email", { exact: true }).fill(environment.users[0]!);
  await page.getByLabel("Kata sandi", { exact: true }).fill("deliberately-wrong-synthetic-password");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText("Email atau kata sandi salah.");
  await login(page); await createWorkbook(page, "Error handling sintetis");
  await page.getByRole("button", { name: "Tambah vendor", exact: true }).click();
  await expect(page.getByLabel("Nama vendor", { exact: true })).toHaveAttribute("required", "");
  await expect(page.getByLabel("Vendor", { exact: true }).locator("option")).toHaveCount(1);

  let failedMutation = "", retriedMutation = "";
  await page.route("**/api/workbook", async route => {
    const body = route.request().postDataJSON(); failedMutation = body.request.mutationId;
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "STORAGE_UNAVAILABLE" }) });
  }, { times: 1 });
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simpan", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Penyimpanan tidak tersedia");
  await expect(page.getByRole("heading", { name: "Proyek sintetis Fase 5 / Error handling sintetis", exact: true })).toBeVisible();
  await page.route("**/api/workbook", async route => { retriedMutation = route.request().postDataJSON().request.mutationId; await route.continue(); }, { times: 1 });
  await save(page); expect(retriedMutation).toBe(failedMutation);

  await page.getByLabel("HPP manual INU", { exact: true }).fill("123");
  await page.context().clearCookies({ name: /^procurement_/ });
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Masuk", exact: true })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(environment.users[0]!);
  await page.getByLabel("Kata sandi", { exact: true }).fill(environment.password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveValue("123");
  await save(page);

  // Delete only the access cookie to force the normal refresh-token flow, without printing secrets.
  await page.context().clearCookies({ name: "procurement_access" });
  await page.reload(); await expect(page.getByText("Sesi aktif", { exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.filter(c => c.name.startsWith("procurement_")).every(c => c.httpOnly && c.sameSite === "Strict")).toBe(true);
  await page.context().clearCookies({ name: "procurement_access" });
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Masuk", exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole("heading", { name: "Masuk", exact: true })).toBeVisible();
  expect((await page.context().cookies()).filter(c => c.name.startsWith("procurement_"))).toHaveLength(0);
});

test("HPP context becomes NEEDS_REVIEW after upstream changes and Analysis state remains independent", async ({ page }) => {
  await login(page); await createWorkbook(page, "Konteks HPP sintetis");
  await page.getByLabel("HPP manual INU", { exact: true }).fill("100");
  await addField(page, "Biaya Konversi", "KONVERSI_JAGAD", "90");
  await configure(page, { "HPP manual INU": "IDR/L", "HPP manual SOLAR_BAWAH": "IDR/L", "Biaya Konversi": "IDR/L" });
  await save(page);
  const firstAnalysisURL = page.url();
  await page.getByRole("button", { name: "Catat konteks HPP dari run tersimpan" }).click();
  await expect(page.getByTestId("hpp-review")).toHaveText("DRAFT");
  await save(page);
  await page.getByLabel("Biaya Konversi", { exact: true }).fill("95");
  await expect(page.getByTestId("hpp-review")).toHaveText("NEEDS_REVIEW");
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveValue("100");
  await save(page); await page.reload(); await openTools(page);
  await expect(page.getByTestId("hpp-review")).toHaveText("NEEDS_REVIEW");
  const projectId = await page.getByLabel("Induk proyek", { exact: true }).locator("option").filter({ hasText: "Proyek sintetis Fase 5" }).last().getAttribute("value");
  expect(projectId).toBeTruthy();
  await page.getByLabel("Induk proyek", { exact: true }).selectOption(projectId!);
  await page.getByLabel("Nama Analysis", { exact: true }).fill("Analysis kedua independen");
  await page.getByRole("button", { name: "Buat workbook kosong" }).click();
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Biaya Konversi", { exact: true })).toHaveCount(0);
  await save(page);
  await page.goto(firstAnalysisURL);
  await openTools(page);
  await expect(page.getByLabel("HPP manual INU", { exact: true })).toHaveValue("100");
  await expect(page.getByLabel("Biaya Konversi", { exact: true })).toHaveValue("95");
});

test("reference image layout: vendor and conversion left, colored AHS right, editable sheet persists", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await login(page); await createWorkbook(page, "Desain sesuai referensi");
  await page.getByRole("button", { name: "Pengaturan workbook", exact: true }).click();
  const sheet = page.getByTestId("procurement-sheet");
  await sheet.screenshot({ path: test.info().outputPath("reference-layout.png") });
  const vendor = await page.getByRole("table", { name: "Evaluasi harga vendor", exact: true }).boundingBox();
  const conversion = await page.getByRole("table", { name: "Konversi Satuan INU", exact: true }).boundingBox();
  const ahs = await page.getByRole("table", { name: "Analisis Harga Satuan AHS", exact: true }).boundingBox();
  expect(vendor!.width).toBeCloseTo(404, 0); expect(conversion!.width).toBeCloseTo(303, 0); expect(ahs!.width).toBeCloseTo(606, 0);
  expect(ahs!.x - vendor!.x).toBeCloseTo(505, 0); expect(ahs!.y).toBeCloseTo(vendor!.y, 0);
  expect(conversion!.x).toBe(vendor!.x); expect(conversion!.y).toBeGreaterThan(vendor!.y + vendor!.height);
  await expect(sheet.locator(".ahs-title th")).toHaveCSS("background-color", "rgb(255, 255, 0)");
  await expect(sheet.locator(".income-row").first()).toHaveCSS("background-color", "rgb(0, 255, 0)");
  await expect(sheet.locator(".cost-row").first()).toHaveCSS("background-color", "rgb(255, 102, 102)");
  await expect(sheet.locator(".profit-row").first()).toHaveCSS("background-color", "rgb(153, 153, 153)");
  await page.getByLabel("Lembar AHS · HPP · Harga Dasar", { exact: true }).fill("777");
  await page.getByRole("button", { name: "Simpan workbook", exact: true }).click();
  await expect(page.getByRole("status", { name: "Status operasi", exact: true })).toHaveText("Draft tersimpan.");
  await page.reload();
  await expect(page.getByLabel("Lembar AHS · HPP · Harga Dasar", { exact: true })).toHaveValue("777");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.getByLabel("Lembar procurement", { exact: true }).evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
});

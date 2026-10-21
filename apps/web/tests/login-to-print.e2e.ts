import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("login sampai cetak workbook", async ({ app, screen, browser }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("E2E_EMAIL dan E2E_PASSWORD wajib diisi.");

  await app.open("/");
  await screen.getByLabel("Email").fill(email);
  await screen.getByLabel("Kata sandi").fill(password);
  await screen.getByRole("button", { name: "Masuk dengan Email" }).click();
  await expect(screen.getByRole("status", { name: "Status operasi" })).toContainText("Berhasil masuk.");

  await screen.getByRole("button", { name: "＋ Proyek baru" }).click();
  await screen.getByLabel("Nama proyek *").fill(`E2E ${Date.now()}`);
  await screen.getByLabel("Nama analisis *").fill("Flow login sampai print");
  await screen.getByLabel("Pekerjaan / Material *").fill("HSD");
  await screen.getByLabel("Customer *").fill("TesterArmy");
  await screen.getByLabel("Lokasi *").fill("Lokal");
  await screen.getByRole("button", { name: "Buat workbook" }).click();

  await expect(browser.locator('[data-testid="procurement-sheet"]')).toBeVisible();
  await screen.getByLabel("Vendor untuk Konversi").selectOption({ label: "Vendor 1" });
  await screen.getByRole("button", { name: "Cetak ke PDF" }).click();
  await expect(browser.locator(".print-button")).toHaveCount(1);
});

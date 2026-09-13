import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

describe("category kind (income/expense)", () => {
  it("defaults kind to 'expense' on create", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/categories").send({ name: "Groceries" });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("expense");
  });

  it("accepts kind 'income' on create and returns it", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/categories").send({ name: "Salary", kind: "income" });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("income");
  });

  it("GET returns kind for each category", async () => {
    const { app } = await makeApp();
    await request(app).post("/api/categories").send({ name: "Salary", kind: "income" });
    const res = await request(app).get("/api/categories");
    const salary = res.body.find((c: { name: string }) => c.name === "Salary");
    expect(salary.kind).toBe("income");
  });

  it("PATCH can change kind to income", async () => {
    const { app } = await makeApp();
    const cat = (await request(app).post("/api/categories").send({ name: "Bonus" })).body;
    const res = await request(app).patch(`/api/categories/${cat.id}`).send({ kind: "income" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("income");
  });

  it("supports kind 'both' (usable as expense and income)", async () => {
    const { app } = await makeApp();
    const cat = (await request(app).post("/api/categories").send({ name: "Gifts" })).body;
    const res = await request(app).patch(`/api/categories/${cat.id}`).send({ kind: "both" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("both");
  });
});

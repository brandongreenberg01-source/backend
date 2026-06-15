import request from "supertest";
import express from "express";
import adminRouter from "../routes/admin";
import { getSolarData, getSatelliteData } from "../routes/iot";
import { updateImpactScore, getTotalProjects } from "../lib/registry";

// Mock all external dependencies (Stellar RPC, IoT data, registry)
jest.mock("../routes/iot", () => ({
  getSolarData: jest.fn(),
  getSatelliteData: jest.fn(),
}));

jest.mock("../lib/registry", () => ({
  updateImpactScore: jest.fn(),
  getTotalProjects: jest.fn(),
}));

describe("POST /api/admin/update-scores", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
  });

  const mockIotData = () => {
    (getSolarData as jest.Mock).mockReturnValue({
      efficiency_pct: 80,
      power_output_kw: 800,
      max_power_kw: 1000,
      timestamp: Date.now(),
    });
    (getSatelliteData as jest.Mock).mockReturnValue({
      forest_density_pct: 60,
      ndvi_score: 0.6,
      timestamp: Date.now(),
    });
  };

  describe("happy path", () => {
    it("updates scores for specified project IDs", async () => {
      mockIotData();
      (updateImpactScore as jest.Mock).mockResolvedValue("tx_hash_abc123");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({ project_ids: [1, 2] })
        .expect(200);

      expect(res.body).toEqual({
        updated: 2,
        results: [
          {
            project_id: 1,
            tx_hash: "tx_hash_abc123",
            credit_quality: 80,
            green_impact: 70,
          },
          {
            project_id: 2,
            tx_hash: "tx_hash_abc123",
            credit_quality: 80,
            green_impact: 70,
          },
        ],
        errors: [],
      });
    });
  });

  describe("unauthorized rejection", () => {
    afterEach(() => {
      delete process.env.ADMIN_API_KEY;
    });

    it("rejects with 401 when ADMIN_API_KEY is set but no token provided", async () => {
      process.env.ADMIN_API_KEY = "super-secret-key";

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({ project_ids: [1] })
        .expect(401);

      expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("rejects with 401 when a wrong token is provided", async () => {
      process.env.ADMIN_API_KEY = "super-secret-key";

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer wrong-token")
        .send({ project_ids: [1] })
        .expect(401);

      expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("allows requests with correct token", async () => {
      process.env.ADMIN_API_KEY = "super-secret-key";
      mockIotData();
      (updateImpactScore as jest.Mock).mockResolvedValue("tx_hash_xyz");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .set("Authorization", "Bearer super-secret-key")
        .send({ project_ids: [1] })
        .expect(200);

      expect(res.body.updated).toBe(1);
    });

    it("allows requests when ADMIN_API_KEY is not set (no auth)", async () => {
      mockIotData();
      (updateImpactScore as jest.Mock).mockResolvedValue("tx_hash_no_auth");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({ project_ids: [1] })
        .expect(200);

      expect(res.body.updated).toBe(1);
    });
  });

  describe("bad input handling", () => {
    it("defaults to all projects when project_ids is omitted", async () => {
      (getTotalProjects as jest.Mock).mockResolvedValue(3);
      mockIotData();
      (updateImpactScore as jest.Mock).mockResolvedValue("tx_hash_all");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({})
        .expect(200);

      expect(res.body.updated).toBe(3);
      expect(getTotalProjects).toHaveBeenCalledTimes(1);
    });

    it("defaults to all projects when project_ids is an empty array", async () => {
      (getTotalProjects as jest.Mock).mockResolvedValue(2);
      mockIotData();
      (updateImpactScore as jest.Mock).mockResolvedValue("tx_hash_empty");

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({ project_ids: [] })
        .expect(200);

      expect(res.body.updated).toBe(2);
    });

    it("handles per-project failures gracefully without failing the entire batch", async () => {
      (getSolarData as jest.Mock)
        .mockReturnValueOnce({
          efficiency_pct: 90,
          power_output_kw: 900,
          max_power_kw: 1000,
        })
        .mockReturnValueOnce({
          efficiency_pct: 50,
          power_output_kw: 300,
          max_power_kw: 1000,
        });
      (getSatelliteData as jest.Mock)
        .mockReturnValueOnce({
          forest_density_pct: 80,
          ndvi_score: 0.8,
        })
        .mockReturnValueOnce({
          forest_density_pct: 20,
          ndvi_score: 0.2,
        });
      (updateImpactScore as jest.Mock)
        .mockResolvedValueOnce("tx_hash_ok")
        .mockRejectedValueOnce(new Error("RPC timeout"));

      const res = await request(app)
        .post("/api/admin/update-scores")
        .send({ project_ids: [1, 2] })
        .expect(200);

      expect(res.body.updated).toBe(1);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].project_id).toBe(1);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0]).toMatchObject({ project_id: 2 });
      expect(res.body.errors[0].error).toContain("RPC timeout");
    });
  });
});
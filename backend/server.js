const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const app = express();

/* MIDDLEWARE */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

/* CONFIG */
const JWT_SECRET = process.env.JWT_SECRET || "replace_with_a_strong_secret_in_prod";
const QR_TOKEN_TTL = "30d"; // adjust as needed

/* DB CONNECTION */
const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "hospital_db",
    password: "0987",
    port: 5432,
});

pool.connect()
    .then(() => console.log("✅ DB connected successfully"))
    .catch(err => console.error("❌ DB connection error", err));

/* Doctor assign function (unchanged behavior) */
function assignDoctor(disease) {
    const d = (disease || "").toLowerCase();
    if (["fever", "flu", "cold", "headache", "migraine"].includes(d))
        return { name: "Dr Arun", specialization: "General Physician" };
    if (d.includes("heart"))
        return { name: "Dr Meena", specialization: "Cardiologist" };
    if (d.includes("skin") || d.includes("allergy"))
        return { name: "Dr Suresh", specialization: "Dermatologist" };
    if (d.includes("lung") || d.includes("asthma"))
        return { name: "Dr Parivendhan", specialization: "Pulmonologist" };
    return { name: "Dr Arun", specialization: "General Physician" };
}

/* ➕ ADD PATIENT (returns patient_id and qrToken in response) */
app.post("/add-patient", async (req, res) => {
    try {
        const {
            patient_name,
            gender,
            age,
            disease,
            priority,
            time_slot,
            bp,
            temp,
            weight,
            phone
        } = req.body;

        const doctor = assignDoctor(disease);

        const insertQ = `
          INSERT INTO patients
            (patient_name, gender, age, disease,
             priority, time_slot,
             blood_pressure, heart_rate, allergies,
             temperature, weight_kg, phone_number,
             visit_date, doctor_name, doctor_specialization)
          VALUES
            ($1,$2,$3,$4,$5,$6,$7,72,'None',$8,$9,$10,CURRENT_DATE,$11,$12)
          RETURNING patient_id, visit_date;
        `;
        const params = [
            patient_name,
            gender,
            age || 0,
            disease,
            priority || null,
            time_slot || null,
            bp || null,
            temp || null,
            weight || null,
            phone,
            doctor.name,
            doctor.specialization
        ];

        const insertRes = await pool.query(insertQ, params);
        const created = insertRes.rows[0]; // { patient_id, visit_date }

        // Create signed token to include in QR (server will verify)
        const token = jwt.sign({ patient_id: created.patient_id }, JWT_SECRET, { expiresIn: QR_TOKEN_TTL });

        // Return message + created id + token (non-breaking addition)
        res.json({
            message: "Patient added",
            patient_id: created.patient_id,
            visit_date: created.visit_date,
            qrToken: token
        });
    } catch (err) {
        console.error("❌ ADD ERROR:", err);
        res.status(500).send("Error adding patient");
    }
});

/* 📋 GET ALL PATIENTS (unchanged) */
app.get("/patients", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                patient_id,
                patient_name,
                gender,
                age,
                disease,
                priority,
                time_slot,
                blood_pressure,
                temperature,
                weight_kg,
                phone_number,
                visit_date,
                doctor_name,
                doctor_specialization
            FROM patients
            ORDER BY patient_id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("❌ FETCH ERROR:", err);
        res.status(500).send("Error fetching patients");
    }
});

/* 🔴 Delete Patient (unchanged) */
app.delete("/patients/:id", async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM patients WHERE patient_id = $1", [id]);
        res.json({ message: "Patient deleted" });
    } catch (err) {
        console.error("❌ DELETE ERROR:", err);
        res.status(500).send("Delete Failed");
    }
});

/* 🔴 Edit/Update Patient (unchanged) */
app.put("/patients/:id", async (req, res) => {
    const { id } = req.params;
    const {
        patient_name, gender, age, disease,
        priority, time_slot, blood_pressure,
        temperature, weight_kg, phone_number
    } = req.body;

    try {
        await pool.query(`
            UPDATE patients SET
                patient_name = $1,
                gender = $2,
                age = $3,
                disease = $4,
                priority = $5,
                time_slot = $6,
                blood_pressure = $7,
                temperature = $8,
                weight_kg = $9,
                phone_number = $10
            WHERE patient_id = $11
        `, [
            patient_name, gender, age, disease,
            priority, time_slot, blood_pressure,
            temperature, weight_kg, phone_number, id
        ]);
        res.json({ message: "Patient updated" });
    } catch (err) {
        console.error("❌ UPDATE ERROR:", err);
        res.status(500).send("Update Failed");
    }
});

/* ➕ Analytics (read-only) for dashboard */
app.get("/analytics", async (req, res) => {
  try {
    const totalPerMonthQ = `
      SELECT to_char(date_trunc('month', visit_date), 'YYYY-MM') AS month,
             COUNT(*)::int AS count
      FROM patients
      WHERE visit_date IS NOT NULL
        AND visit_date >= (date_trunc('month', CURRENT_DATE) - interval '11 months')
      GROUP BY month
      ORDER BY month;
    `;

    const genderQ = `
      SELECT COALESCE(NULLIF(gender, ''), 'Unknown') AS gender,
             COUNT(*)::int AS count
      FROM patients
      GROUP BY gender;
    `;

    const diseaseQ = `
      SELECT COALESCE(disease, 'Unknown') AS disease,
             COUNT(*)::int AS count
      FROM patients
      GROUP BY disease
      ORDER BY count DESC
      LIMIT 10;
    `;

    const frequentThisMonthQ = `
      SELECT COALESCE(disease, 'Unknown') AS disease,
             COUNT(*)::int AS count
      FROM patients
      WHERE date_trunc('month', visit_date) = date_trunc('month', CURRENT_DATE)
      GROUP BY disease
      ORDER BY count DESC
      LIMIT 1;
    `;

    const [monthRes, genderRes, diseaseRes, frequentRes] = await Promise.all([
      pool.query(totalPerMonthQ),
      pool.query(genderQ),
      pool.query(diseaseQ),
      pool.query(frequentThisMonthQ),
    ]);

    res.json({
      totalPerMonth: monthRes.rows,
      genderCounts: genderRes.rows,
      diseaseDistribution: diseaseRes.rows,
      mostFrequentThisMonth: frequentRes.rows[0] || null,
    });
  } catch (err) {
    console.error("❌ ANALYTICS ERROR:", err);
    res.status(500).send("Error fetching analytics");
  }
});

/* ➕ QR lookup endpoint - returns full details after verifying token */
app.get("/appointment/qr/:token", async (req, res) => {
  const token = req.params.token;
  if (!token) return res.status(400).send("Missing token");

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const patientId = payload.patient_id;
    if (!patientId) return res.status(400).send("Invalid token payload");

    const q = `
      SELECT patient_id, patient_name, gender, age, disease,
             priority, time_slot, blood_pressure, temperature,
             weight_kg, phone_number, visit_date, doctor_name, doctor_specialization
      FROM patients
      WHERE patient_id = $1
      LIMIT 1
    `;
    const r = await pool.query(q, [patientId]);
    if (r.rowCount === 0) return res.status(404).send("Appointment not found");

    const appt = r.rows[0];

    if (req.query.format === "json" || req.headers.accept?.includes("application/json")) {
      return res.json(appt);
    }

    const escape = (v) => String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Appointment #${escape(appt.patient_id)}</title>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <style>
            body{font-family:Segoe UI,Arial; padding:20px; background:#f6faff; color:#0b2e4f;}
            .card{max-width:720px;margin:auto;background:white;padding:18px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.08);}
            h2{margin:0 0 8px}
            .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef4fb;}
            .label{color:#475d73;font-weight:600}
            .value{color:#0b2e4f}
            .footer{margin-top:14px;font-size:13px;color:#5a6d80;}
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Appointment Details</h2>
            <div class="row"><div class="label">Appointment ID</div><div class="value">${escape(appt.patient_id)}</div></div>
            <div class="row"><div class="label">Patient Name</div><div class="value">${escape(appt.patient_name)}</div></div>
            <div class="row"><div class="label">Gender / Age</div><div class="value">${escape(appt.gender)} / ${escape(appt.age)}</div></div>
            <div class="row"><div class="label">Disease</div><div class="value">${escape(appt.disease)}</div></div>
            <div class="row"><div class="label">Priority</div><div class="value">${escape(appt.priority)}</div></div>
            <div class="row"><div class="label">Preferred Time Slot</div><div class="value">${escape(appt.time_slot)}</div></div>
            <div class="row"><div class="label">Visit Date</div><div class="value">${escape(appt.visit_date)}</div></div>
            <div class="row"><div class="label">Phone</div><div class="value">${escape(appt.phone_number)}</div></div>
            <div class="row"><div class="label">Doctor</div><div class="value">${escape(appt.doctor_name)} — ${escape(appt.doctor_specialization)}</div></div>
            <div class="footer">Presented via secure token. This page was generated by the hospital system.</div>
          </div>
        </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error("❌ QR verify/fetch error", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).send("Token expired");
    }
    return res.status(400).send("Invalid token");
  }
});

/* Convenience redirect: /appointment/:token -> /appointment/qr/:token */
app.get('/appointment/:token', (req, res) => {
  const t = req.params.token || '';
  res.redirect(`/appointment/qr/${encodeURIComponent(t)}`);
});

/* Start server on all interfaces so LAN devices can reach it (helpful for mobile scanning in dev) */
app.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Server running on http://localhost:3000 (listening on 0.0.0.0)");
});

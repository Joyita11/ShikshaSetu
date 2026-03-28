import express from "express";
import bodyParser from "body-parser";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import multer from "multer";
import session from "express-session";
import fs from "fs";

/* ===================== BASIC SETUP ===================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

/* ===================== DB ===================== */
const db = new pg.Client({
    user: "postgres",
    host: "localhost",
    database: "Students_directory",
    password: "admin",
    port: 5432,
});

db.connect()
    .then(() => console.log("✅ DB Connected"))
    .catch(err => {
        console.error("❌ DB Connection Failed", err);
        process.exit(1);
    });

/* ===================== VIEW + MIDDLEWARE ===================== */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));



app.use(
    session({
        secret: "tuitionpro_secret",
        resave: false,
        saveUninitialized: false,
    })
);

/* ===================== ENSURE UPLOAD FOLDERS ===================== */
const ensureDir = dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

ensureDir("public/uploads/profiles");
ensureDir("public/uploads/tasks");

/* ===================== MULTER ===================== */
const profileUpload = multer({
    storage: multer.diskStorage({
        destination: "public/uploads/profiles",
        filename: (req, file, cb) =>
            cb(null, Date.now() + path.extname(file.originalname)),
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) =>
        file.mimetype.startsWith("image/")
            ? cb(null, true)
            : cb(new Error("Only images allowed")),
});

const taskUpload = multer({
    storage: multer.diskStorage({
        destination: "public/uploads/tasks",
        filename: (req, file, cb) =>
            cb(null, Date.now() + path.extname(file.originalname)),
    }),
    fileFilter: (req, file, cb) =>
        file.mimetype.startsWith("image/") ||
            file.mimetype === "application/pdf"
            ? cb(null, true)
            : cb(new Error("Invalid file type")),
});

/* ===================== ROOT ===================== */
const requireTeacher = (req, res, next) => {
    if (!req.session.userId || req.session.role !== "teacher") {
        return res.redirect("/");
    }
    next();
};


const requireStudent = (req, res, next) => {
    if (req.session.role !== "student" || !req.session.studentId)
        return res.redirect("/");
    next();
};




app.get("/", (req, res) => {
    res.render("hp");
});

app.get("/register", (req, res) => {
    res.render("auth/register");  // make sure this file exists
});
app.get("/login", (req, res) => {
    res.render("auth/login"); // make sure this file exists
});
app.post("/login", async (req, res) => {
    const { email, password, role } = req.body;

    try {
        const result = await db.query(
            "SELECT * FROM users WHERE email = $1 AND password = $2 AND role = $3",
            [email, password, role]
        );

        if (result.rows.length === 0) {
            return res.render("auth/login", { error: "Invalid credentials" });
        }

        const user = result.rows[0];

        req.session.userId = user.id;
        req.session.role = user.role;

        /* ================= TEACHER LOGIN ================= */
        if (user.role === "teacher") {

            const teacherResult = await db.query(
                "SELECT id FROM teachers WHERE user_id = $1",
                [user.id]
            );

            if (teacherResult.rows.length === 0) {
                return res.send("Teacher record not found.");
            }

            req.session.teacherId = teacherResult.rows[0].id;

            return res.redirect("/teacher/dashboard");
        }

        /* ================= STUDENT LOGIN ================= */
        if (user.role === "student") {

            const studentResult = await db.query(
                "SELECT id FROM students WHERE user_id = $1",
                [user.id]
            );

            if (studentResult.rows.length === 0) {
                return res.send("Student record not found.");
            }

            req.session.studentId = studentResult.rows[0].id;

            return res.redirect("/student/dashboard");
        }


    } catch (err) {
        console.error("Login error:", err);
        res.status(500).send("Login failed");
    }
});

app.post("/register", async (req, res) => {
    const { name, email, password, role } = req.body;

    try {

        /* ================= STUDENT CHECK FIRST ================= */
        if (role === "student") {

            const studentCheck = await db.query(
                "SELECT id, user_id FROM students WHERE email = $1",
                [email]
            );

            if (studentCheck.rows.length === 0) {
                return res.send("You are not registered by any teacher.");
            }

            if (studentCheck.rows[0].user_id) {
                return res.send("Account already registered. Please login.");
            }
        }

        /* ================= CREATE USER ================= */
        const userResult = await db.query(
            "INSERT INTO users (email, password, role) VALUES ($1,$2,$3) RETURNING id",
            [email, password, role]
        );

        const userId = userResult.rows[0].id;

        /* ================= LINK STUDENT ================= */
        if (role === "student") {
            await db.query(
                "UPDATE students SET user_id = $1 WHERE email = $2",
                [userId, email]
            );
        }

        /* ================= CREATE TEACHER ================= */
        if (role === "teacher") {
            await db.query(
                "INSERT INTO teachers (user_id, name) VALUES ($1,$2)",
                [userId, name]
            );
        }

        res.redirect("/login");

    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.send("Registration failed: " + err.message);
    }
});










/* ===================== DASHBOARD ===================== */
app.get("/teacher/dashboard", requireTeacher, async (req, res) => {
    try {
        const students = await db.query("SELECT COUNT(*) FROM students WHERE teacher_id=$1", [req.session.teacherId]);
        const batches = await db.query(
            "SELECT COUNT(DISTINCT batch) FROM students WHERE teacher_id=$1",
            [req.session.teacherId]
        );
        const pendingFees = await db.query(`
  SELECT COUNT(DISTINCT s.id)
  FROM students s
  LEFT JOIN fee_payments fp ON s.id = fp.student_id
  WHERE fp.is_paid = false AND s.teacher_id = $1
`, [req.session.teacherId]);

        const totalDoubts = await db.query(`
    SELECT COUNT(*)
    FROM doubts d
    JOIN students s ON d.student_id = s.id
    WHERE s.teacher_id = $1 AND d.status = 'pending'
`, [req.session.teacherId]);

        res.render("teacher/dashboard", {
            title: "Teacher Dashboard",
            totalStudents: Number(students.rows[0].count),
            activeBatches: Number(batches.rows[0].count),
            pendingFees: Number(pendingFees.rows[0].count),
            totalDoubts: Number(totalDoubts.rows[0].count) // Placeholder, you can replace with actual count from DB
        });
    } catch (err) {
        console.error("Dashboard Error:", err);
        res.status(500).render("error", {
            message: "Dashboard failed",
            status: 500,
        });
    }
});


/* ===================== DOUBTS ===================== */
app.get("/teacher/doubts", requireTeacher, async (req, res) => {

    try {

        const result = await db.query(`
            SELECT 
                d.id,
                s.name AS student_name,
                d.subject,
                d.question,
                d.answer,
                d.status,
                d.created_at
            FROM doubts d
            JOIN students s ON d.student_id = s.id
            WHERE s.teacher_id = $1
            ORDER BY d.created_at DESC
        `, [req.session.teacherId]);

        res.render("teacher/doubts", {
            doubts: result.rows
        });

    } catch (err) {
        console.error(err);
        res.send("Error loading doubts");
    }

});
app.post("/teacher/doubts/reply/:id", requireTeacher, async (req, res) => {

    const doubtId = req.params.id;
    const { answer } = req.body;

    try {

        await db.query(`
            UPDATE doubts
            SET answer = $1,
                status = 'Solved'
            WHERE id = $2
        `, [answer, doubtId]);

        res.redirect("/teacher/doubts");

    } catch (err) {
        console.error(err);
        res.send("Reply failed");
    }

});
/* ===================== STUDENTS ===================== */
app.get("/teacher/students", requireTeacher, async (req, res) => {
    try {
        const students = await db.query(
            "SELECT * FROM students WHERE teacher_id=$1",
            [req.session.teacherId]
        );

        res.render("teacher/students", { students: students.rows });
    } catch (err) {
        console.error(err);
        res.render("teacher/students", { students: [] });
    }
});

app.post("/teacher/students/add", async (req, res) => {
    try {
        const { name, email, class: cls, batch, school, fees, joining_date } = req.body;

        await db.query(
            `INSERT INTO students 
            (name, class, batch, school, monthly_fees, joining_date, teacher_id, email)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [name, cls, batch, school, fees, joining_date, req.session.teacherId, email]
        );

        res.redirect("/teacher/students");

    } catch (err) {
        console.error(err);
        res.redirect("/teacher/students");
    }
});


app.post("/teacher/students/edit/:id", async (req, res) => {
    const { id } = req.params;
    const { name, email, class: studentClass, batch, school, fees, joining_date } = req.body;
    try {
        await db.query(`
    UPDATE students 
    SET name = $1, 
        email = $2, 
        "class" = $3, 
        batch = $4, 
        school = $5, 
        monthly_fees = $6, 
        joining_date = $7
    WHERE id = $8 AND teacher_id = $9
`, [name, email, studentClass, batch, school, fees, joining_date, id, req.session.teacherId]);

        res.redirect("/teacher/students");
    } catch (err) {
        console.error("Edit student error:", err.message);
        res.send("Error updating student");
    }
});

app.post("/teacher/students/delete/:id", async (req, res) => {
    await db.query(
        `DELETE FROM students 
     WHERE id = $1 AND teacher_id = $2`,
        [req.params.id, req.session.teacherId]
    );

    res.redirect("/teacher/students");
});
/* ===================== FEES ===================== */
app.get("/teacher/fees", requireTeacher, async (req, res) => {
    try {
        const result = await db.query(`
      SELECT 
        s.id,
            s.name,
            s.batch,
            s.monthly_fees,
            COALESCE(
                ARRAY_AGG(fp.month) FILTER(WHERE fp.is_paid = false),
                '{}'
            ) AS pending_months,
            COUNT(fp.id) FILTER(WHERE fp.is_paid = false) * s.monthly_fees AS total_due
      FROM students s
LEFT JOIN fee_payments fp ON s.id = fp.student_id
WHERE s.teacher_id = $1
GROUP BY s.id

      ORDER BY s.name
            `, [req.session.teacherId]);

        res.render("teacher/fees", { students: result.rows });
    } catch (err) {
        console.error(err);
        res.render("teacher/fees", { students: [] });
    }
});

app.post("/teacher/fees/toggle-month", async (req, res) => {
    const { student_id, month, year } = req.body;

    await db.query(
        `
        INSERT INTO fee_payments(student_id, month, year, is_paid)
        VALUES($1, $2, $3, false)
        ON CONFLICT (student_id, month, year)
DO UPDATE SET is_paid = NOT fee_payments.is_paid

        `,
        [student_id, month, year]
    );

    res.redirect("/teacher/fees");
});

/* ===================== TASKS ===================== */
app.get("/teacher/tasks", requireTeacher, async (req, res) => {
    const students = await db.query(
        "SELECT id,name,batch FROM students WHERE teacher_id=$1 ORDER BY id DESC",
        [req.session.teacherId]
    );

    res.render("teacher/tasks", { students: students.rows });
});

app.post(
    "/teacher/tasks/full-submit",
    taskUpload.single("material"),
    async (req, res) => {
        try {
            const { student_id, title } = req.body;
            let tasks = req.body.tasks || [];
            if (!Array.isArray(tasks)) tasks = [tasks];

            const material = req.file
                ? `/uploads/tasks/${req.file.filename}`

                : null;

            const a = await db.query(
                `
        INSERT INTO assignments (student_id,title,material_path,teacher_id)
VALUES ($1,$2,$3,$4)
 RETURNING id
            `,
                [student_id, title, material, req.session.teacherId]
            );

            for (const t of tasks) {
                if (t?.trim())
                    await db.query(
                        "INSERT INTO assignment_tasks (assignment_id,task_text) VALUES ($1,$2)",
                        [a.rows[0].id, t]
                    );
            }

            res.redirect("/teacher/tasks");
        } catch (err) {
            console.error(err);
            res.status(500).render("error", {
                message: "Task upload failed",
                status: 500,
            });
        }
    }
);





/* ===================== STUDENT VIEW ===================== */

app.get("/student/dashboard", requireStudent, async (req, res) => {
    try {

        // 1️⃣ Get student using user_id (NOT student_profiles)
        const studentResult = await db.query(
            "SELECT * FROM students WHERE user_id = $1",
            [req.session.userId]
        );

        if (studentResult.rows.length === 0) {
            return res.redirect("/");
        }

        const student = studentResult.rows[0];
        const studentId = student.id;

        // 2️⃣ Assignment Stats
        const statsResult = await db.query(`
            SELECT 
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'Pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'Completed') AS completed
            FROM assignments
            WHERE student_id = $1
        `, [studentId]);

        const stats = {
            assignments: parseInt(statsResult.rows[0]?.total) || 0,
            pending: parseInt(statsResult.rows[0]?.pending) || 0,
            completed: parseInt(statsResult.rows[0]?.completed) || 0
        };

        // 3️⃣ Fee Calculation
        const feeResult = await db.query(`
            SELECT 
                COUNT(*) FILTER (WHERE is_paid = false) AS unpaid_months,
                COUNT(*) FILTER (WHERE is_paid = true) AS paid_months
            FROM fee_payments
            WHERE student_id = $1
        `, [studentId]);

        const unpaidMonths = parseInt(feeResult.rows[0]?.unpaid_months) || 0;
        const paidMonths = parseInt(feeResult.rows[0]?.paid_months) || 0;

        const monthlyFees = student.monthly_fees || 0;

        const totalDue = unpaidMonths * monthlyFees;
        const totalPaid = paidMonths * monthlyFees;

        let feeStatus = "Paid";

        if (unpaidMonths > 0 && paidMonths > 0) {
            feeStatus = "Unpaid";
        } else if (unpaidMonths > 0) {
            feeStatus = "Unpaid";
        }

        // 4️⃣ Render
        res.render("student/dashboard", {
            student,
            stats,
            feeStatus,
            totalDue,
            totalPaid,
            unpaidMonths
        });

    } catch (err) {
        console.error("Student Dashboard Error:", err);
        res.send("Error: " + err.message);
    }
});





app.get("/student/fees", requireStudent, async (req, res) => {

    const studentRow = await db.query(
        "SELECT id, monthly_fees FROM students WHERE user_id = $1",
        [req.session.userId]
    );

    const student = studentRow.rows[0];

    const payments = await db.query(
        "SELECT * FROM fee_payments WHERE student_id = $1",
        [student.id]
    );

    res.render("student/fees.ejs", {
        student,
        payments: payments.rows
    });

});


app.post("/student/fees/mark-paid", requireStudent, async (req, res) => {

    const { month, year } = req.body;

    const studentRow = await db.query(
        "SELECT id FROM students WHERE user_id = $1",
        [req.session.userId]
    );

    const studentId = studentRow.rows[0].id;

    await db.query(
        `
        UPDATE fee_payments
        SET is_paid = true
        WHERE student_id = $1 AND month = $2 AND year = $3
        `,
        [studentId, month, year]
    );

    res.redirect("/student/fees");
});

app.get("/student/tasks", requireStudent, async (req, res) => {

    try {

        const studentId = req.session.studentId;

        const assignments = await db.query(`
            SELECT * 
            FROM assignments
            WHERE student_id = $1
            ORDER BY id DESC
        `, [studentId]);

        for (let a of assignments.rows) {

            const tasks = await db.query(`
                SELECT id, task_text, is_completed
                FROM assignment_tasks
                WHERE assignment_id = $1
            `, [a.id]);

            a.tasks = tasks.rows;
        }

        res.render("student/tasks", { assignments: assignments.rows });

    } catch (err) {
        console.error("Student tasks error:", err);
        res.redirect("/student/dashboard");
    }

});
app.post("/student/tasks/complete/:taskId", requireStudent, async (req, res) => {

    const taskId = req.params.taskId;
    const studentId = req.session.studentId;

    try {

        // 1️⃣ Mark task completed
        const taskResult = await db.query(`
            UPDATE assignment_tasks
            SET is_completed = true
            WHERE id = $1
            RETURNING assignment_id
        `, [taskId]);

        const assignmentId = taskResult.rows[0].assignment_id;

        // 2️⃣ Check if any tasks are still pending
        const pendingTasks = await db.query(`
            SELECT COUNT(*) 
            FROM assignment_tasks
            WHERE assignment_id = $1 AND is_completed = false
        `, [assignmentId]);

        // 3️⃣ If none pending → mark assignment completed
        if (pendingTasks.rows[0].count == 0) {

            await db.query(`
                UPDATE assignments
                SET status = 'Completed'
                WHERE id = $1 AND student_id = $2
            `, [assignmentId, studentId]);

        }

        res.redirect("/student/tasks");

    } catch (err) {

        console.error(err);
        res.send("Task completion failed");

    }

});
/* ===================== STUDENT DOUBTS ===================== */

// GET: Display the doubt posting page for students
app.get("/student/doubts", requireStudent, async (req, res) => {
    try {
        const studentId = req.session.studentId;

        // Fetch existing doubts for this student from the database
        // Assuming you have a table named 'doubts'
        const result = await db.query(
            `SELECT * FROM doubts WHERE student_id = $1 ORDER BY created_at DESC`,
            [studentId]
        );

        res.render("student/doubts", {
            title: "Post Doubts",
            doubts: result.rows
        });
    } catch (err) {
        console.error("Error fetching doubts:", err);
        // If the table doesn't exist yet, we pass an empty array to prevent crash
        res.render("student/doubts", {
            title: "Post Doubts",
            doubts: []
        });
    }
});

// POST: Handle new doubt submission
app.post("/student/doubts/post", requireStudent, async (req, res) => {
    try {
        const { subject, question } = req.body;
        const studentId = req.session.studentId;

        await db.query(
            `INSERT INTO doubts (student_id, subject, question, status, created_at) 
             VALUES ($1, $2, $3, 'pending', NOW())`,
            [studentId, subject, question]
        );

        res.redirect("/student/doubts");
    } catch (err) {
        console.error("Error posting doubt:", err);
        res.status(500).send("Failed to submit doubt. Check if the 'doubts' table exists.");
    }
});

/* ===================== LOGOUT ===================== */
app.get("/logout", (req, res) => {
    req.session.destroy();
    res.redirect("/");
});

/* ===================== 404 ===================== */
app.use((req, res) =>
    res.status(404).render("error", {
        message: "Page not found",
        status: 404,
    })
);

/* ===================== SERVER ===================== */
app.listen(port, () =>
    console.log(`🚀 Server running at http://localhost:${port}`)
);

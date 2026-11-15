var express = require("express");
var fileuploader = require("express-fileupload");
var cloudinary = require("cloudinary").v2;
var path = require("path");
var fs = require("fs");
const fetch = require("node-fetch");
const cors = require("cors");
require("dotenv").config();
const mysql = require("mysql2");
const { Readable } = require("stream");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite"
});

var app = express();

const PORT = process.env.PORT || 2500;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileuploader());
app.use(express.static(path.join(__dirname, "public")));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));

async function generateWithRetry(model, request) {

    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {

        try {
            return await model.generateContent(request);

        } catch (error) {

            const status = error.status;

            if (
                status !== 503 &&
                status !== 500 &&
                status !== 429
            ) {
                throw error;
            }

            if (attempt === maxRetries) {
                throw error;
            }

            const delay = 2000 * Math.pow(2, attempt);

            console.log(
                `Gemini temporarily unavailable. Retrying in ${delay / 1000} seconds...`
            );

            await sleep(delay);
        }
    }
}

// CLOUDINARY BUFFER UPLOAD FUNCTION
function uploadBufferToCloudinary(buffer, folder = "aadhaar") {
    return new Promise((resolve, reject) => {

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: "image"
            },
            (error, result) => {

                if (error) {
                    return reject(error);
                }

                resolve(result);
            }
        );

        Readable.from([buffer]).pipe(uploadStream);
    });
}

// AIVEN MYSQL DATABASE CONNECTION
const requiredDbEnv = [
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME"
];

const missingDbEnv = requiredDbEnv.filter(
    (key) => !process.env[key]
);
if (missingDbEnv.length > 0) {
    console.error(
        "Missing database environment variables:",
        missingDbEnv.join(", ")
    );
    process.exit(1);
}

const caPath = path.resolve(
    __dirname,
    process.env.DB_SSL_CA_PATH || "ca.pem"
);

if (!fs.existsSync(caPath)) {
    console.error(
        `Aiven CA certificate not found at: ${caPath}`
    );
    process.exit(1);
}

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    ssl: {
        ca: fs.readFileSync(caPath),
        rejectUnauthorized: true
    },
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 5,
    idleTimeout: 60000,
    queueLimit: 0,

    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

// HOME ROUTE
app.get("/", function (req, resp) {
    resp.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

// CHECK EMAIL
app.get("/chk-email", (req, res) => {

    const { emailid } = req.query;

    if (!emailid) {
        return res.status(400).send("Email is required");
    }

    db.query(
        "SELECT emailid FROM signup WHERE emailid = ?",
        [emailid],
        (err, records) => {

            if (err) {
                console.error(
                    "CHK EMAIL DATABASE ERROR:",
                    err
                );

                return res.status(500).send("Database Error");
            }

            if (records.length > 0) {
                return res.send("❌ Already Taken...");
            }

            return res.send("✅ Available...");
        }
    );
});

// SIGNUP
// Kept as GET for compatibility with your existing frontend.
// Migrate to POST and bcrypt before production.

app.get("/signup", (req, res) => {

    const { emailid, password, usertype } = req.query;

    if (!emailid || !password || !usertype) {
        return res.status(400).send(
            "Email, password and user type are required"
        );
    }

    const sql = `
        INSERT INTO signup
        (emailid, password, usertype, status)
        VALUES (?, ?, ?, ?)
    `;

    db.query(
        sql,
        [emailid, password, usertype, "active"],
        (err) => {

            if (err) {
                console.error(
                    "SIGNUP DATABASE ERROR:",
                    err
                );

                if (err.code === "ER_DUP_ENTRY") {
                    return res.status(409).send(
                        "This email is already registered"
                    );
                }

                return res.status(500).send("Signup failed");
            }

            return res.send("✅ Signup Successful");
        }
    );
});

// LOGIN

app.get("/login", function (req, resp) {

    let { emailid, password } = req.query;

    let query = `
        SELECT * FROM signup
        WHERE emailid = ? AND password = ?
    `;

    db.query(
        query,
        [emailid, password],
        function (err, result) {

            if (err) {
                console.error(
                    "LOGIN DATABASE ERROR:",
                    err
                );

                return resp.status(500).send(
                    "Database Error"
                );

            } else if (result.length === 0) {

                resp.json({ status: "invalid" });

            } else if (result[0].status === "blocked") {

                resp.json({ status: "blocked" });

            } else {

                resp.json({
                    status: "success",
                    usertype: result[0].usertype
                });
            }
        }
    );
});

// CHANGE PASSWORD

app.post("/change-password", (req, res) => {

    const {
        emailid,
        oldpassword,
        newpassword
    } = req.body;

    if (!emailid || !oldpassword || !newpassword) {
        return res.status(400).send(
            "All fields are required"
        );
    }

    db.query(
        "SELECT * FROM signup WHERE emailid = ? AND password = ?",
        [emailid, oldpassword],
        (err, rows) => {

            if (err) {
                console.error("CHANGE PASSWORD ERROR:", err);
                return res.status(500).send("Database Error");
            }

            if (rows.length === 0) {
                return res.status(400).send(
                    "❌ Invalid Old Password"
                );
            }

            db.query(
                "UPDATE signup SET password = ? WHERE emailid = ?",
                [newpassword, emailid],
                (err2) => {

                    if (err2) {
                        console.error(
                            "PASSWORD UPDATE ERROR:",
                            err2
                        );

                        return res.status(500).send(
                            "Update Failed"
                        );
                    }

                    return res.send(
                        "✅ Password Updated Successfully"
                    );
                }
            );
        }
    );
});

// SAVE ORGANIZER DETAILS

app.post("/save-org-details", async function (req, resp) {

    try {

        let emailid = req.body.emailid;
        let orgname = req.body.orgname;
        let regnumber = req.body.regnumber;
        let address = req.body.address;
        let city = req.body.city;
        let sports = req.body.sports;
        let website = req.body.website;
        let insta = req.body.insta;
        let head = req.body.head || req.body.orgname;
        let contact = req.body.contact;
        let otherinfo = req.body.otherinfo;

        let picurl = "nopic.jpg";

        if (req.files && req.files.picurl) {

            const fileObj = req.files.picurl;

            if (!fileObj.data || !fileObj.mimetype.startsWith("image/")) {
                return resp.status(400).send(
                    "Please upload a valid organizer image."
                );
            }

            const result = await uploadBufferToCloudinary(
                fileObj.data,
                "organizer-profiles"
            );

            picurl = result.secure_url;
        }

        let query = `
            INSERT INTO organizers
            (emailid, orgname, regnumber, address, city,
             sports, website, insta, head, contact, picurl, otherinfo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        let values = [
            emailid,
            orgname,
            regnumber,
            address,
            city,
            sports,
            website,
            insta,
            head,
            contact,
            picurl,
            otherinfo
        ];

        db.query(query, values, function (err) {

            if (err) {
                console.error("ORGANIZER INSERT ERROR:", err);

                return resp.status(500).send(
                    "Database insert failed"
                );
            }

            return resp.send(
                "Organizer details saved successfully."
            );
        });

    } catch (error) {

        console.error("ORGANIZER SAVE ERROR:", error);

        return resp.status(500).send(
            "Organizer details could not be saved"
        );
    }
});

// GET ORGANIZER DETAILS

app.get("/get-org-details", function (req, res) {

    let { emailid } = req.query;

    db.query(
        "SELECT * FROM organizers WHERE emailid = ?",
        [emailid],
        function (err, results) {

            if (err) {
                console.error("GET ORGANIZER ERROR:", err);

                return res.status(500).send(
                    "Database error"
                );
            }

            if (results.length === 0) {
                return res.status(404).send(
                    "No organizer found."
                );
            }

            res.send(results[0]);
        }
    );
});

// MODIFY ORGANIZER DETAILS

app.post("/modify-org-details", async function (req, res) {

    try {

        let emailid = req.body.emailid;
        let orgname = req.body.orgname;
        let regnumber = req.body.regnumber;
        let address = req.body.address;
        let city = req.body.city;
        let sports = req.body.sports;
        let website = req.body.website;
        let insta = req.body.insta;
        let head = req.body.head || req.body.orgname;
        let contact = req.body.contact;
        let otherinfo = req.body.otherinfo;

        let updateQuery = `
            UPDATE organizers
            SET orgname=?, regnumber=?, address=?, city=?,
                sports=?, website=?, insta=?, head=?, contact=?,
                picurl=?, otherinfo=?
            WHERE emailid=?
        `;

        let picurl = req.body.hdn || "nopic.jpg";

        if (req.files && req.files.picurl) {

            const fileObj = req.files.picurl;

            if (!fileObj.data || !fileObj.mimetype.startsWith("image/")) {
                return res.status(400).send(
                    "Please upload a valid organizer image."
                );
            }

            const result = await uploadBufferToCloudinary(
                fileObj.data,
                "organizer-profiles"
            );

            picurl = result.secure_url;

        } else {

            const rows = await new Promise((resolve, reject) => {

                db.query(
                    "SELECT picurl FROM organizers WHERE emailid = ?",
                    [emailid],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    }
                );
            });

            picurl = rows.length
                ? (rows[0].picurl || "nopic.jpg")
                : "nopic.jpg";
        }

        let values = [
            orgname,
            regnumber,
            address,
            city,
            sports,
            website,
            insta,
            head,
            contact,
            picurl,
            otherinfo,
            emailid
        ];

        db.query(updateQuery, values, function (err) {

            if (err) {
                console.error("ORGANIZER UPDATE ERROR:", err);

                return res.status(500).send(
                    "Database update failed."
                );
            }

            res.send(
                "Organizer details updated successfully."
            );
        });

    } catch (error) {

        console.error("MODIFY ORGANIZER ERROR:", error);

        return res.status(500).send(
            "Organizer update failed"
        );
    }
});

// READ AADHAAR USING GEMINI AI

app.post("/read-aadhaar", async function (req, res) {

    try {

        // Check uploaded file
        if (!req.files || !req.files.acardpic) {
            return res.status(400).send(
                "No Aadhaar file uploaded"
            );
        }

        const fileObj = req.files.acardpic;

        // Validate image
        if (!fileObj.data || !fileObj.mimetype.startsWith("image/")) {
            return res.status(400).send(
                "Please upload a valid image"
            );
        }

        // Upload directly from memory to Cloudinary
        // No local public/uploads folder required
        const cloudinaryResult =
            await uploadBufferToCloudinary(
                fileObj.data,
                "aadhaar"
            );

        const acardpicurl = cloudinaryResult.secure_url;

        // Convert image buffer to Base64
        const imageBase64 = fileObj.data.toString("base64");

        // Gemini prompt
        const prompt = `
        Carefully read the uploaded Aadhaar card image.

        Extract only these three fields:

        1. Name exactly as printed.
        2. Date of Birth in DD/MM/YYYY format.
        3. Gender (Male, Female, or Other).

        Important:
        - Do not guess missing information.
        - If a field is unclear, return an empty string.
        - Return valid JSON only.
        - Do not include markdown or explanations.

        Expected format:
        {
            "name": "",
            "dob": "",
            "gender": ""
        }
        `;

        // Send image to Gemini
        const result = await generateWithRetry(model, {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: fileObj.mimetype,
                                data: imageBase64
                            }
                        }
                    ]
                }
            ]
        });

        // Get Gemini response
        let responseText = result.response.text()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

        console.log("GEMINI AADHAAR RESPONSE:", responseText);

        // Parse JSON
        let parsed;

        try {
            parsed = JSON.parse(responseText);
        } catch (err) {
            console.error("GEMINI JSON PARSE ERROR:", err);

            return res.status(500).send(
                "Gemini returned invalid Aadhaar data"
            );
        }

        // Convert DOB into YYYY-MM-DD
        let dob = String(parsed.dob || "").trim();

        const dobMatch = dob.match(
            /^(\d{2})\/(\d{2})\/(\d{4})$/
        );

        if (dobMatch) {
            const [, dd, mm, yyyy] = dobMatch;
            dob = `${yyyy}-${mm}-${dd}`;
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            dob = "";
        }

        // Return extracted information
        return res.json({
            acardpicurl: acardpicurl,
            name: String(parsed.name || "").trim(),
            dob: dob,
            gender: String(parsed.gender || "").trim()
        });

    } catch (error) {

        console.error("GEMINI / AADHAAR ERROR:", error);

        return res.status(500).json({
            error: "Failed to read Aadhaar!",
            details: error.message
        });
    }
});

// SAVE PLAYER

app.post("/save-player", async function (req, res) {

    try {

        let {
            emailid,
            acardpicurl,
            name,
            dob,
            gender,
            address,
            contact,
            game,
            otherinfo
        } = req.body;

        if (!dob || isNaN(Date.parse(dob))) {
            return res.status(400).send("Invalid DOB!");
        }

        dob = new Date(dob).toISOString().slice(0, 10);

        let profilepicurl = "nopic.jpg";

        // Upload profile picture directly to Cloudinary
        if (req.files && req.files.profilepic) {

            const profileObj = req.files.profilepic;

            if (!profileObj.data || !profileObj.mimetype.startsWith("image/")) {
                return res.status(400).send(
                    "Please upload a valid profile image."
                );
            }

            const result = await uploadBufferToCloudinary(
                profileObj.data,
                "player-profiles"
            );

            profilepicurl = result.secure_url;
        }

        let sql = `
            INSERT INTO players
            (emailid, acardpicurl, profilepicurl, name, dob,
             gender, address, contact, game, otherinfo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(
            sql,
            [
                emailid,
                acardpicurl,
                profilepicurl,
                name,
                dob,
                gender,
                address,
                contact,
                game,
                otherinfo
            ],
            (err) => {

                if (err) {
                    console.error("SAVE PLAYER ERROR:", err);

                    return res.status(500).send(
                        "Failed to Save Player: " + err.message
                    );
                }

                res.send("Player Saved Successfully.");
            }
        );

    } catch (error) {

        console.error("SAVE PLAYER ERROR:", error);

        res.status(500).send(
            "Failed to save player"
        );
    }
});

// MODIFY PLAYER

app.post("/modify-player", async function (req, res) {

    try {

        let {
            emailid,
            acardpicurl,
            name,
            dob,
            gender,
            address,
            contact,
            game,
            otherinfo,
            existingProfilePic
        } = req.body;

        if (!dob || isNaN(Date.parse(dob))) {
            return res.status(400).send(
                "Invalid DOB format!"
            );
        }

        dob = new Date(dob).toISOString().slice(0, 10);

        let profilepicurl = existingProfilePic || "nopic.jpg";

        // Upload new profile picture directly to Cloudinary
        if (req.files && req.files.profilepic) {

            const profileObj = req.files.profilepic;

            if (!profileObj.data || !profileObj.mimetype.startsWith("image/")) {
                return res.status(400).send(
                    "Please upload a valid profile image."
                );
            }

            const result = await uploadBufferToCloudinary(
                profileObj.data,
                "player-profiles"
            );

            profilepicurl = result.secure_url;
        }

        let sql = `
            UPDATE players
            SET acardpicurl=?, profilepicurl=?, name=?, dob=?,
                gender=?, address=?, contact=?, game=?, otherinfo=?
            WHERE emailid=?
        `;

        db.query(
            sql,
            [
                acardpicurl,
                profilepicurl,
                name,
                dob,
                gender,
                address,
                contact,
                game,
                otherinfo,
                emailid
            ],
            (err) => {

                if (err) {
                    console.error("UPDATE PLAYER ERROR:", err);

                    return res.status(500).send(
                        "Failed to Update Player: " + err.message
                    );
                }

                res.send("Player Updated Successfully.");
            }
        );

    } catch (error) {

        console.error("MODIFY PLAYER ERROR:", error);

        res.status(500).send(
            "Failed to update player"
        );
    }
});

// GET PLAYER DETAILS

app.get("/get-player", function (req, res) {

    const emailid = req.query.emailid;

    if (!emailid) {
        return res.status(400).send("Email is required");
    }

    let sql = "SELECT * FROM players WHERE emailid=?";

    db.query(sql, [emailid], function (err, rows) {

        if (err) {
            console.error("GET PLAYER ERROR:", err);

            return res.status(500).send(
                "Failed to fetch player"
            );
        }

        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.json({});
        }
    });
});

// SAVE TOURNAMENT

app.post("/save-tournament", function (req, resp) {

    if (!req.files || !req.files.poster) {
        return resp.status(400).send(
            "Tournament poster is required!"
        );
    }

    const posterFile = req.files.poster;

    if (!posterFile.data || !posterFile.mimetype.startsWith("image/")) {
        return resp.status(400).send(
            "Please upload a valid tournament poster."
        );
    }

    const uploadStream = cloudinary.uploader.upload_stream(
        {
            folder: "tournaments",
            resource_type: "image"
        },
        function (err, result) {

            if (err) {
                console.error("CLOUDINARY UPLOAD ERROR:", err);

                return resp.status(500).send(
                    "Cloudinary Upload Failed!"
                );
            }

            const posterurl = result.secure_url;

            const {
                emailid,
                event,
                doe,
                toe,
                address,
                city,
                sports,
                minage,
                maxage,
                lastdate,
                fee,
                prize,
                contact
            } = req.body;

            const sql = `
                INSERT INTO tournaments
                (emailid, event, doe, toe, address, city, sports,
                 minage, maxage, lastdate, fee, prize, contact, posterurl)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            db.query(
                sql,
                [
                    emailid,
                    event,
                    doe,
                    toe,
                    address,
                    city,
                    sports,
                    parseInt(minage, 10),
                    parseInt(maxage, 10),
                    lastdate,
                    parseInt(fee, 10),
                    parseInt(prize, 10),
                    contact,
                    posterurl
                ],
                function (err) {

                    if (err) {
                        console.error(
                            "TOURNAMENT DATABASE ERROR:",
                            err
                        );

                        return resp.status(500).send(
                            "Tournament Save Failed!"
                        );
                    }

                    resp.send(
                        "✅ Tournament Posted Successfully!"
                    );
                }
            );
        }
    );

    uploadStream.end(posterFile.data);
});

// GET ORGANIZER TOURNAMENTS

app.get("/get-tournaments", function (req, res) {

    const emailid = req.query.emailid;

    const sql = `
        SELECT * FROM tournaments
        WHERE emailid = ?
    `;

    db.query(sql, [emailid], function (err, result) {

        if (err) {
            console.error("GET TOURNAMENTS ERROR:", err);

            return res.status(500).send("Fetch Error");
        }

        res.send(result);
    });
});

// DELETE TOURNAMENT

app.delete("/delete-tournament", function (req, res) {

    const rid = req.query.rid;

    if (!rid) {
        return res.status(400).send(
            "Tournament ID is required"
        );
    }

    const sql = `
        DELETE FROM tournaments
        WHERE rid = ?
    `;

    db.query(sql, [rid], function (err) {

        if (err) {
            console.error("DELETE TOURNAMENT ERROR:", err);

            return res.status(500).send(
                "Delete Failed"
            );
        }

        res.send("Tournament Deleted Successfully");
    });
});

// GET ALL TOURNAMENTS

app.get("/get-all-tournaments", (req, res) => {

    db.query(
        "SELECT * FROM tournaments",
        (err, result) => {

            if (err) {
                console.error(
                    "GET ALL TOURNAMENTS ERROR:",
                    err
                );

                return res.status(500).send(
                    "Server error"
                );
            }

            res.json(result);
        }
    );
});

// SEARCH TOURNAMENTS

app.get("/search-tournaments", (req, res) => {

    let { city, sports } = req.query;

    let query = "SELECT * FROM tournaments WHERE 1";

    let params = [];

    if (city) {
        query += " AND city LIKE ?";
        params.push("%" + city + "%");
    }

    if (sports) {
        query += " AND sports LIKE ?";
        params.push("%" + sports + "%");
    }

    db.query(query, params, (err, result) => {

        if (err) {
            console.error("SEARCH TOURNAMENTS ERROR:", err);

            return res.status(500).send(
                "Server error"
            );
        }

        res.json(result);
    });
});

// ADMIN: GET ALL USERS

app.get("/get-all-users", (req, res) => {

    db.query(
        "SELECT emailid, usertype, status FROM signup",
        [],
        function (err, records) {

            if (err) {
                console.error("GET USERS ERROR:", err);

                return res.status(500).send(
                    "Error fetching users"
                );
            }

            res.json(records);
        }
    );
});

// ADMIN: UPDATE USER STATUS

app.post("/update-user-status", (req, res) => {

    const { emailid, status } = req.body;

    if (!emailid || !["active", "blocked"].includes(status)) {
        return res.status(400).send(
            "Valid email and status are required"
        );
    }

    db.query(
        "UPDATE signup SET status = ? WHERE emailid = ?",
        [status, emailid],
        (err, result) => {

            if (err) {
                console.error("UPDATE USER STATUS ERROR:", err);

                return res.status(500).send(
                    "Error updating status"
                );
            }

            if (result.affectedRows === 0) {
                return res.status(404).send(
                    "User not found"
                );
            }

            res.send("Status updated successfully");
        }
    );
});

// ADMIN: GET ALL ORGANIZERS

app.get("/get-all-organizers", (req, res) => {

    db.query(
        `SELECT emailid, orgname, regnumber, contact, sports, picurl
         FROM organizers`,
        [],
        function (err, records) {

            if (err) {
                console.error("GET ORGANIZERS ERROR:", err);

                return res.status(500).send(
                    "Error fetching organizers"
                );
            }

            res.json(records);
        }
    );
});

// ADMIN: GET ALL PLAYERS

app.get("/get-all-players", (req, res) => {

    db.query(
        "SELECT * FROM players",
        [],
        (err, records) => {

            if (err) {
                console.error("GET PLAYERS ERROR:", err);

                return res.status(500).send(
                    "Error loading players"
                );
            }

            res.json(records);
        }
    );
});

// START SERVER AFTER DATABASE CONNECTION

db.getConnection((err, connection) => {

    if (err) {
        console.error("AIVEN MYSQL CONNECTION FAILED");
        console.error("Error code:", err.code);
        console.error("Error message:", err.message);

        process.exit(1);
    }

    console.log("AIVEN MYSQL CONNECTED SUCCESSFULLY");

    connection.query(
        "SELECT DATABASE() AS databaseName",
        (queryErr, rows) => {

            connection.release();

            if (queryErr) {
                console.error(
                    "DATABASE VERIFICATION FAILED:",
                    queryErr
                );

                process.exit(1);
            }

            console.log(
                "Connected database:",
                rows[0].databaseName
            );

            app.listen(PORT, "0.0.0.0", () => {
                console.log(
                    `VictoryGrid server running on port ${PORT}`
                );
            });
        }
    );
});
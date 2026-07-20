var express = require("express");
var fileuploader = require("express-fileupload");
var cloudinary = require("cloudinary").v2;
var mysql2 = require("mysql2");
var path = require("path");
const fetch = require("node-fetch");
const cors = require("cors");
require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); 

var app = express();

app.use(fileuploader());

const PORT = process.env.PORT || 2500;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

app.use(express.static("public"));

app.use(express.urlencoded(true));
app.use(express.json());
app.use(cors());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
let db = mysql2.createConnection(process.env.DATABASE_URL);
db.connect(function (err) {
  if (err == null) {
    console.log("Aiven connected successfully...");
  } else {
    console.log("DB Connection Error: " + err.message);
  }
});

app.get("/", function (req, resp) {
  resp.sendFile(__dirname + "/public/index.html");
});

app.get("/chk-email", (req, res) => {
  const { emailid } = req.query;
  db.query(
    "SELECT * FROM signup WHERE emailid=?",
    [emailid],
    (err, records) => {
      if (err) return res.status(500).send("Server Error");
      if (records.length > 0) res.send("❌ Already Taken...");
      else res.send("✅ Available...");
    }
  );
});

app.get("/signup", (req, res) => {
  const { emailid, password, usertype } = req.query;
  db.query(
    "INSERT INTO signup VALUES (?,?,?,?)",
    [emailid, password, usertype, "active"],
    (err) => {
      if (err) return res.status(500).send(" Signup failed");
      res.send("✅ Signup Successful");
    }
  );
});

app.get("/login", function (req, resp) {
  let { emailid, password } = req.query;
  let query = "SELECT * FROM signup WHERE emailid=? AND password=?";
  db.query(query, [emailid, password], function (err, result) {
    if (err) {
      resp.status(500).send("Server Error");
    } else if (result.length === 0) {
      resp.json({ status: "invalid" });
    } else if (result[0].status === "blocked") {
      resp.json({ status: "blocked" });
    } else {
      resp.json({ status: "success", usertype: result[0].usertype });
    }
  });
});

app.post("/change-password", (req, res) => {
  const { emailid, oldpassword, newpassword } = req.body;
  if (!emailid || !oldpassword || !newpassword)
    return res.status(400).send(" All fields are required");

  db.query(
    "SELECT * FROM signup WHERE emailid=? AND password=?",
    [emailid, oldpassword],
    (err, rows) => {
      if (err) return res.status(500).send(" Database Error");
      if (rows.length === 0)
        return res.status(400).send("❌ Invalid Old Password");
      db.query(
        "UPDATE signup SET password=? WHERE emailid=?",
        [newpassword, emailid],
        (err2) => {
          if (err2) return res.status(500).send(" Update Failed");
          return res.send("✅ Password Updated Successfully");
        }
      );
    }
  );
});

app.post("/save-org-details", async function (req, resp) {
  let emailid = req.body.emailid;
  let orgname = req.body.orgname;
  let regnumber = req.body.regnumber;
  let address = req.body.address;
  let city = req.body.city;
  let sports = req.body.sports;
  let website = req.body.website;
  let insta = req.body.insta;
  let head = req.body.orgname;
  let contact = req.body.contact;
  let otherinfo = req.body.otherinfo;

  let picurl = "nopic.jpg";

  if (req.files && req.files.picurl) {
    let fileObj = req.files.picurl;
    let localPath = path.join(__dirname, "/public/uploads/", fileObj.name);

    await fileObj.mv(localPath);
    let result = await cloudinary.uploader.upload(localPath);
    picurl = result.secure_url;
  }

  let query = `INSERT INTO organizers (emailid, orgname, regnumber, address, city, sports, website, insta, head, contact, picurl, otherinfo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
    otherinfo,
  ];

  db.query(query, values, function (err) {
    if (err) {
      console.error("DB Insert Error:", err);
      return resp.status(500).send("Database insert failed: " + err);
    }

    return resp.send("Organizer details saved successfully..");
  });
});

app.get("/get-org-details", function (req, res) {
  let { emailid } = req.query;
  db.query(
    "SELECT * FROM organizers WHERE emailid=?",
    [emailid],
    function (err, results) {
      if (err) {
        return res.status(500).send("Database error: " + err.message);
      }
      if (results.length === 0)
        return res.status(404).send("No organizer found.");
      res.send(results[0]);
    }
  );
});

app.post("/modify-org-details", async function (req, res) {
  let emailid = req.body.emailid;
  let orgname = req.body.orgname;
  let regnumber = req.body.regnumber;
  let address = req.body.address;
  let city = req.body.city;
  let sports = req.body.sports;
  let website = req.body.website;
  let insta = req.body.insta;
  let head = req.body.orgname;
  let contact = req.body.contact;
  let otherinfo = req.body.otherinfo;

  let updateQuery = `UPDATE organizers SET orgname=?, regnumber=?, address=?, city=?, sports=?, website=?, insta=?, head=?, contact=?, picurl=?, otherinfo=? WHERE emailid=?`;

  let picurl = req.body.hdn || "nopic.jpg";

  if (req.files && req.files.picurl) {
    let fileObj = req.files.picurl;
    let localPath = path.join(__dirname, "/public/uploads/", fileObj.name);
    await fileObj.mv(localPath);
    let result = await cloudinary.uploader.upload(localPath);
    picurl = result.secure_url;
  } else {
    let [record] = await new Promise((resolve, reject) => {
      db.query(
        "SELECT picurl FROM organizers WHERE emailid=?",
        [emailid],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
    picurl = record.picurl || "nopic.jpg";
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
    emailid,
  ];

  db.query(updateQuery, values, function (err) {
    if (err) return res.status(500).send("Database update failed.");
    res.send("Organizer details updated successfully..");
  });
});

// gemini
app.post("/read-aadhaar", async function (req, res) {
  if (!req.files || !req.files.acardpic)
    return res.status(400).send("No Aadhaar file uploaded");

  const fileObj = req.files.acardpic;
  const localPath = path.join(__dirname, "/public/uploads/", fileObj.name);
  await fileObj.mv(localPath);

  const cloudinaryResult = await cloudinary.uploader.upload(localPath);
  const acardpicurl = cloudinaryResult.secure_url;

  const fs = require("fs");
  const imageBase64 = fs.readFileSync(localPath, { encoding: "base64" });

  const prompt = `
From this Aadhaar card image, extract only:
1. Name (as it appears)
2. DOB (in DD/MM/YYYY format)
3. Gender (Male/Female/Other)

Respond in pure JSON without any extra text like below:
{"name": "...", "dob": "DD/MM/YYYY", "gender": "..."}
    `;

  try {
    const result = await model.generateContent({
      contents: [
        {
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
    });

    let responseText = result.response
      .text()
      .replace(/```json|```/g, "")
      .replace(/[\r\n]/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (err) {
      console.error(
        "JSON Parse Error:",
        err.message,
        "Raw Response:",
        responseText
      );
      return res.status(500).send("Failed to parse Aadhaar data!");
    }

    let dob = (parsed.dob || "").trim();
    if (dob.includes("/")) {
      const [dd, mm, yyyy] = dob.split("/");
      if (dd && mm && yyyy)
        dob = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    } else if (dob.includes("-")) {
      const [dd, mm, yyyy] = dob.split("-");
      if (dd && mm && yyyy)
        dob = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    } else dob = "";

    res.json({
      acardpicurl,
      name: parsed.name?.trim() || "",
      dob,
      gender: parsed.gender?.trim() || "",
    });
  } catch (error) {
    console.log("Gemini Error:", error.message);
    res.status(500).send("Failed to read Aadhaar!");
  }
});

app.post("/save-player", async function (req, res) {
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
  } = req.body;

  if (!dob || isNaN(Date.parse(dob)))
    return res.status(400).send(" Invalid DOB!");
  dob = new Date(dob).toISOString().slice(0, 10);

  let profilepicurl = "nopic.jpg";
  if (req.files && req.files.profilepic) {
    let profileObj = req.files.profilepic;
    let pathProf = path.join(__dirname, "/public/uploads/", profileObj.name);
    await profileObj.mv(pathProf);
    let result = await cloudinary.uploader.upload(pathProf);
    profilepicurl = result.secure_url;
  }

  let sql = `INSERT INTO players VALUES (?,?,?,?,?,?,?,?,?,?)`;
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
      otherinfo,
    ],
    (err) => {
      if (err)
        return res.status(500).send("Failed to Save Player: " + err.message);
      res.send("Player Saved Successfully.");
    }
  );
});

app.post("/modify-player", async function (req, res) {
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
    existingProfilePic,
  } = req.body;

  try {
    dob = new Date(dob).toISOString().slice(0, 10);
  } catch {
    return res.status(400).send(" Invalid DOB format!");
  }

  let profilepicurl = existingProfilePic || "nopic.jpg";
  if (req.files && req.files.profilepic) {
    let profileObj = req.files.profilepic;
    let pathProf = path.join(__dirname, "/public/uploads/", profileObj.name);
    await profileObj.mv(pathProf);
    let result = await cloudinary.uploader.upload(pathProf);
    profilepicurl = result.secure_url;
  }

  let sql = `UPDATE players SET acardpicurl=?, profilepicurl=?, name=?, dob=?, gender=?, address=?, contact=?, game=?, otherinfo=? WHERE emailid=?`;
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
      emailid,
    ],
    (err) => {
      if (err)
        return res.status(500).send("Failed to Update Player: " + err.message);
      res.send("Player Updated Successfully.");
    }
  );
});

app.get("/get-player", function (req, res) {
  const emailid = req.query.emailid;
  let sql = "SELECT * FROM players WHERE emailid=?";
  db.query(sql, [emailid], function (err, rows) {
    if (err) {
      res.status(500).send("Failed to fetch player");
    } else if (rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.json({});
    }
  });
});

app.post("/save-tournament", function (req, resp) {
  if (!req.files || !req.files.poster) {
    resp.status(400).send(" Tournament poster is required!");
    return;
  }

  let posterFile = req.files.poster;
  cloudinary.uploader
    .upload_stream({ folder: "tournaments" }, function (err, result) {
      if (err) {
        resp.status(500).send(" Cloudinary Upload Failed!");
      } else {
        let posterurl = result.secure_url;
        let {
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
          contact,
        } = req.body;

        let sql = `INSERT INTO tournaments 
            (emailid, event, doe, toe, address, city, sports, minage, maxage, lastdate, fee, prize, contact, posterurl)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

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
            parseInt(minage),
            parseInt(maxage),
            lastdate,
            parseInt(fee),
            parseInt(prize),
            contact,
            posterurl,
          ],
          function (err) {
            if (err) {
              resp.status(500).send(" Tournament Save Failed!");
            } else {
              resp.send("✅ Tournament Posted Successfully!");
            }
          }
        );
      }
    })
    .end(posterFile.data);
});

app.get("/get-tournaments", function (req, res) {
  let emailid = req.query.emailid;
  let sql = "SELECT * FROM tournaments WHERE emailid=?";
  db.query(sql, [emailid], function (err, result) {
    if (err) res.status(500).send("Fetch Error");
    else res.send(result);
  });
});

app.delete("/delete-tournament", function (req, res) {
  let rid = req.query.rid;
  let sql = "DELETE FROM tournaments WHERE rid=?";
  db.query(sql, [rid], function (err) {
    if (err) res.status(500).send("Delete Failed");
    else res.send("Tournament Deleted Successfully");
  });
});

app.get("/get-all-tournaments", (req, res) => {
  db.query("SELECT * FROM tournaments", (err, result) => {
    if (err) res.status(500).send("Server error");
    else res.json(result);
  });
});

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
    if (err) res.status(500).send("Server error");
    else res.json(result);
  });
});

app.get("/get-all-users", (req, res) => {
  db.query(
    "SELECT emailid, usertype, status FROM signup",
    [],
    function (err, records) {
      if (err) return res.status(500).send("Error fetching users");
      res.json(records);
    }
  );
});

app.post("/update-user-status", (req, res) => {
  const { emailid, status } = req.body;
  db.query(
    "UPDATE signup SET status = ? WHERE emailid = ?",
    [status, emailid],
    (err, result) => {
      if (err) res.status(500).send("Error updating status");
      else res.send("Status updated successfully");
    }
  );
});

app.get("/get-all-organizers", (req, res) => {
  db.query(
    "SELECT emailid, orgname, regnumber, contact, sports, picurl FROM organizers",
    [],
    function (err, records) {
      if (err) {
        console.log("DB Error:", err);
        return res.status(500).send("Error fetching organizers");
      }
      res.json(records);
    }
  );
});

app.get("/get-all-players", (req, res) => {
  db.query("SELECT * FROM players", [], (err, records) => {
    if (err) {
      console.log(err);
      return res.status(500).send("Error loading players");
    }
    res.json(records);
  });
});

require('dotenv').config();
const express = require('express');
const path = require('path');
const { WebflowClient } = require('webflow-api');
const { scripts } = require('webflow-api/api');
const sqlite3 = require('sqlite3').verbose();
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const db = new sqlite3.Database('./db/database.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS access_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      site_id TEXT,
      site_short_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        console.error('Error creating table:', err);
      }
    }
  );

  db.all(`PRAGMA table_info(access_tokens)`, (err, columns) => {
    if (err) {
      console.error('Error reading table metadata:', err);
      return;
    }

    const names = new Set(columns.map((column) => column.name));

    if (!names.has('site_id')) {
      db.run(`ALTER TABLE access_tokens ADD COLUMN site_id TEXT`);
    }

    if (!names.has('site_short_name')) {
      db.run(`ALTER TABLE access_tokens ADD COLUMN site_short_name TEXT`);
    }
  });
});

async function generateIntegrityHash(url) {
  const response = await fetch(url);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const hash = crypto
    .createHash("sha384")
    .update(buffer)
    .digest("base64");

  return `sha384-${hash}`;
}


async function registerScriptForSite(accessToken, siteId) {

  const scripts = [
    {
      id: "beaf_script_loader",
      hostedLocation: "https://wpassisthub.com/webflow/beaf-loader.js",
      displayName: "BEAF Loader"
    }
  ];

  for (const script of scripts) {

    const integrityHash = await generateIntegrityHash(script.hostedLocation);

    const response = await fetch(
      `https://api.webflow.com/v2/sites/${siteId}/registered_scripts/hosted`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: script.id,
          hostedLocation: script.hostedLocation,
          version: "1.0.2",
          displayName: script.displayName,
          integrityHash: integrityHash
        })
      }
    );

    const result = await response.json();

    if (response.ok) {
      console.log("Registered:", script.id);
    } else {
      console.error("Failed:", script.id, result);
    }
  }
}

async function applyRuntimeScripts(accessToken, siteId) {

  const response = await fetch(`https://api.webflow.com/v2/sites/${siteId}/custom_code`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      scripts:[{
          id: "beaf_loader",
          location: "footer",
          version: "1.0.2",
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(JSON.stringify(error));
  }

  return response.json();
}

app.get('/auth', (_req, res) => {
  const authorizeUrl = WebflowClient.authorizeURL({
    state: process.env.STATE,
    scope: 'sites:read custom_code:write',
    clientId: process.env.CLIENT_ID,
    redirectUri: process.env.REDIRECT_URI,
  });

  res.redirect(authorizeUrl);
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (state !== process.env.STATE) {
    return res.status(400).send('State does not match');
  }

  try {
    const accessToken = await WebflowClient.getAccessToken({
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI,
    });

    const introspectRes = await fetch('https://api.webflow.com/v2/token/introspect', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const introspect = await introspectRes.json();
    const siteIds = introspect?.authorization?.authorizedTo?.siteIds || [];

    if (!siteIds.length) {
      return res.redirect('https://webflow.com/dashboard');
    }

    const selectedSiteId = siteIds[0];

    const sitesRes = await fetch('https://api.webflow.com/v2/sites', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const sitesData = await sitesRes.json();
    const site = (sitesData?.sites || []).find((item) => item.id === selectedSiteId);

    if (!site?.shortName) {
      return res.redirect('https://webflow.com/dashboard');
    }

    const query = `INSERT INTO access_tokens (token, site_id, site_short_name) VALUES (?, ?, ?)`;
    db.run(query, [accessToken, selectedSiteId, site.shortName], (err) => {
      if (err) {
        console.error('Error saving access token to database:', err);
      } else {
        console.log('Access token saved to database');
      }
    });

    // Register your script to that site
    await registerScriptForSite(accessToken, selectedSiteId);

    await applyRuntimeScripts(accessToken, selectedSiteId);

    return res.redirect(`https://${site.shortName}.design.webflow.com`);
  } catch (error) {
    console.error('Error during OAuth process:', error);
    return res.status(500).send('Internal Server Error');
  }
});

app.get('/get-token', (_req, res) => {
  const query = `SELECT token, site_id, site_short_name, created_at FROM access_tokens ORDER BY created_at DESC LIMIT 1`;
  db.get(query, (err, row) => {
    if (err) {
      console.error('Error retrieving access token:', err);
      return res.status(500).send('Internal Server Error');
    }

    if (!row) {
      return res.status(404).send('No access token found');
    }

    res.json({
      accessToken: row.token,
      siteId: row.site_id,
      siteShortName: row.site_short_name,
      createdAt: row.created_at,
    });
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

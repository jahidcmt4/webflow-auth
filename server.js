require('dotenv').config();
const express = require('express');
const { WebflowClient } = require('webflow-api');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const port = process.env.PORT || 3000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// CORS
app.use(cors());

// -----------------------------
// SQLite DB
// -----------------------------
const db = new sqlite3.Database('./db/database.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    // console.log('Connected to SQLite database');
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
        console.error('Error creating access_tokens table:', err);
      }
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      plan TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      payment_intent_id TEXT UNIQUE,
      amount INTEGER,
      currency TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        console.error('Error creating payments table:', err);
      }
    }
  );

  db.all(`PRAGMA table_info(access_tokens)`, (err, columns) => {
    if (err) {
      console.error('Error reading access_tokens metadata:', err);
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

  db.all(`PRAGMA table_info(payments)`, (err, columns) => {
    if (err) {
      console.error('Error reading payments metadata:', err);
      return;
    }

    const names = new Set(columns.map((column) => column.name));

    if (!names.has('expires_at')) {
      db.run(`ALTER TABLE payments ADD COLUMN expires_at TIMESTAMP NULL`);
    }

    if (!names.has('stripe_customer_id')) {
      db.run(`ALTER TABLE payments ADD COLUMN stripe_customer_id TEXT`);
    }

    if (!names.has('stripe_subscription_id')) {
      db.run(`ALTER TABLE payments ADD COLUMN stripe_subscription_id TEXT`);
    }
  });
});

// -----------------------------
// Helpers
// -----------------------------
function getExpiryDate(plan) {
  const now = new Date();

  if (plan === 'monthly') {
    now.setMonth(now.getMonth() + 1);
    return now.toISOString();
  }

  if (plan === 'yearly') {
    now.setFullYear(now.getFullYear() + 1);
    return now.toISOString();
  }

  return null;
}

function unixToISOString(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function getPlanPriceId(plan) {
  if (plan === 'monthly') return process.env.STRIPE_MONTHLY_PRICE_ID;
  if (plan === 'yearly') return process.env.STRIPE_YEARLY_PRICE_ID;
  return null;
}

function isSubscriptionStatusActive(status) {
  return ['active', 'trialing', 'past_due'].includes(status);
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function findOrCreateStripeCustomer(siteId) {
  const existing = await dbGet(
    `SELECT stripe_customer_id
     FROM payments
     WHERE site_id = ? AND stripe_customer_id IS NOT NULL
     ORDER BY id DESC
     LIMIT 1`,
    [siteId]
  );

  if (existing?.stripe_customer_id) {
    try {
      const customer = await stripe.customers.retrieve(existing.stripe_customer_id);

      if (customer && !customer.deleted) {
        return customer.id;
      }
    } catch (error) {
      console.warn(
        `Saved Stripe customer is invalid for site ${siteId}: ${existing.stripe_customer_id}`
      );
    }
  }

  const customer = await stripe.customers.create({
    metadata: {
      siteId,
    },
  });

  // console.log(`Created new Stripe customer for site ${siteId}: ${customer.id}`);

  return customer.id;
}

async function generateIntegrityHash(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const hash = crypto
    .createHash('sha384')
    .update(buffer)
    .digest('base64');

  return `sha384-${hash}`;
}

async function registerScriptForSite(accessToken, siteId) {
  const scripts = [
    {
      id: 'beaf_script_loader',
      hostedLocation: 'https://wpassisthub.com/webflow/beaf-loader.js',
      displayName: 'BEAF Loader'
    }
  ];

  for (const script of scripts) {
    const integrityHash = await generateIntegrityHash(script.hostedLocation);

    const response = await fetch(
      `https://api.webflow.com/v2/sites/${siteId}/registered_scripts/hosted`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: script.id,
          hostedLocation: script.hostedLocation,
          version: '1.0.3',
          displayName: script.displayName,
          integrityHash
        })
      }
    );

    const result = await response.json();

    if (response.ok) {
      // console.log('Registered:', script.id);
    } else {
      console.error('Failed:', script.id, result);
    }
  }
}

async function applyRuntimeScripts(accessToken, siteId) {
  const response = await fetch(`https://api.webflow.com/v2/sites/${siteId}/custom_code`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      scripts: [
        {
          id: 'beaf_loader',
          location: 'footer',
          version: '1.0.3',
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

// -----------------------------
// Stripe webhook must use RAW body
// and should come BEFORE express.json()
// -----------------------------
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        const siteId = paymentIntent.metadata?.siteId || null;
        const plan = paymentIntent.metadata?.plan || null;

        if (!siteId || plan !== 'lifetime') {
          break;
        }

        const expiresAt = getExpiryDate(plan);

        await dbRun(
          `
          INSERT OR IGNORE INTO payments (
            site_id,
            plan,
            payment_intent_id,
            amount,
            currency,
            status,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [
            siteId,
            plan,
            paymentIntent.id,
            paymentIntent.amount,
            paymentIntent.currency,
            'paid',
            expiresAt
          ]
        );

        // console.log('Lifetime payment saved for site:', siteId);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const siteId = subscription.metadata?.siteId || subscription.items?.data?.[0]?.price?.metadata?.siteId || null;
        const plan = subscription.metadata?.plan || null;
        const customerId = subscription.customer || null;
        const subscriptionId = subscription.id;
        const status = subscription.status;
        const expiresAt =
          unixToISOString(subscription.current_period_end) ||
          unixToISOString(subscription.items?.data?.[0]?.current_period_end);

        if (!siteId) {
          console.warn('Subscription event missing siteId');
          break;
        }

        const existing = await dbGet(
          `SELECT id FROM payments WHERE stripe_subscription_id = ? LIMIT 1`,
          [subscriptionId]
        );

        if (existing) {
          await dbRun(
            `UPDATE payments
             SET status = ?, expires_at = ?, stripe_customer_id = ?, plan = ?
             WHERE stripe_subscription_id = ?`,
            [status, expiresAt, customerId, plan, subscriptionId]
          );
        } else {
          await dbRun(
            `INSERT INTO payments (
              site_id,
              plan,
              stripe_customer_id,
              stripe_subscription_id,
              amount,
              currency,
              status,
              expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              siteId,
              plan,
              customerId,
              subscriptionId,
              null,
              subscription.currency || 'usd',
              status,
              expiresAt
            ]
          );
        }

        // console.log(`Subscription ${event.type} handled for site:`, siteId);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        await dbRun(
          `UPDATE payments
           SET status = ?, expires_at = ?
           WHERE stripe_subscription_id = ?`,
          ['canceled', null, subscriptionId]
        );

        // console.log('Subscription canceled:', subscriptionId);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription || null;
        const customerId = invoice.customer || null;

        if (!subscriptionId) {
          break;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const siteId = subscription.metadata?.siteId || null;
        const plan = subscription.metadata?.plan || null;
        const expiresAt =
          unixToISOString(subscription.current_period_end) ||
          unixToISOString(subscription.items?.data?.[0]?.current_period_end);

        const existing = await dbGet(
          `SELECT id FROM payments WHERE stripe_subscription_id = ? LIMIT 1`,
          [subscriptionId]
        );

        if (existing) {
          await dbRun(
            `UPDATE payments
             SET status = ?, expires_at = ?, stripe_customer_id = ?, plan = ?, amount = ?, currency = ?
             WHERE stripe_subscription_id = ?`,
            [
              subscription.status,
              expiresAt,
              customerId,
              plan,
              invoice.amount_paid || null,
              invoice.currency || 'usd',
              subscriptionId
            ]
          );
        } else if (siteId) {
          await dbRun(
            `INSERT INTO payments (
              site_id,
              plan,
              stripe_customer_id,
              stripe_subscription_id,
              amount,
              currency,
              status,
              expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              siteId,
              plan,
              customerId,
              subscriptionId,
              invoice.amount_paid || null,
              invoice.currency || 'usd',
              subscription.status,
              expiresAt
            ]
          );
        }

        // console.log('Invoice paid handled for subscription:', subscriptionId);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription || null;

        if (!subscriptionId) {
          break;
        }

        await dbRun(
          `UPDATE payments
           SET status = ?
           WHERE stripe_subscription_id = ?`,
          ['past_due', subscriptionId]
        );

        // console.log('Invoice payment failed for subscription:', subscriptionId);
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ received: false });
  }
});

// JSON middleware for normal routes
app.use(express.json());

// -----------------------------
// Payment routes
// -----------------------------
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { plan, siteId } = req.body;

    const plans = {
      monthly: {
        amount: 499,
        currency: 'usd',
      },
      yearly: {
        amount: 4999,
        currency: 'usd',
      },
      lifetime: {
        amount: 9999,
        currency: 'usd',
      },
    };

    const selectedPlan = plans[plan];

    if (!selectedPlan) {
      return res.status(400).json({
        message: 'Invalid plan selected',
      });
    }

    if (!siteId) {
      return res.status(400).json({
        message: 'siteId is required',
      });
    }

    // Check if site already has active access
    const activePayment = await dbGet(
      `SELECT id, plan, status, expires_at
       FROM payments
       WHERE site_id = ?
         AND (
           plan = 'lifetime'
           OR (
             plan IN ('monthly', 'yearly')
             AND status IN ('active', 'trialing', 'past_due', 'paid')
             AND expires_at IS NOT NULL
             AND datetime(expires_at) > datetime('now')
           )
         )
       ORDER BY id DESC
       LIMIT 1`,
      [siteId]
    );

    if (activePayment) {
      return res.status(200).json({
        alreadyPaid: true,
        message: 'This site is already activated',
        plan: activePayment.plan,
        expiresAt: activePayment.expires_at || null,
      });
    }

    // Lifetime: one-time payment
    if (plan === 'lifetime') {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          plan,
          siteId,
        },
      });

      return res.json({
        mode: 'payment',
        clientSecret: paymentIntent.client_secret,
      });
    }

    // Monthly / Yearly: subscription
    const priceId = getPlanPriceId(plan);

    if (!priceId) {
      return res.status(500).json({
        message: `Missing Stripe price ID for ${plan} plan`,
      });
    }

    const customerId = await findOrCreateStripeCustomer(siteId);

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.confirmation_secret'],
      metadata: {
        siteId,
        plan,
      },
    });

    const clientSecret = subscription.latest_invoice?.confirmation_secret?.client_secret;

    if (!clientSecret) {
      console.error('Subscription created but no confirmation secret returned:', {
        subscriptionId: subscription.id,
        status: subscription.status,
        latestInvoice: subscription.latest_invoice,
      });

      return res.status(500).json({
        message: 'Unable to create subscription payment session',
      });
    }

    // create pending row early
    await dbRun(
      `INSERT OR IGNORE INTO payments (
        site_id,
        plan,
        stripe_customer_id,
        stripe_subscription_id,
        amount,
        currency,
        status,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        siteId,
        plan,
        customerId,
        subscription.id,
        selectedPlan.amount,
        selectedPlan.currency,
        subscription.status,
        unixToISOString(subscription.current_period_end) ||
          unixToISOString(subscription.items?.data?.[0]?.current_period_end)
      ]
    );

    return res.json({
      mode: 'subscription',
      clientSecret,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error('Error in create-payment-intent:', error);
    return res.status(500).json({
      message: 'Internal Server Error',
    });
  }
});

app.get('/check-payment', async (req, res) => {
  const { siteId } = req.query;

  if (!siteId) {
    return res.status(400).json({
      paid: false,
      message: 'siteId is required',
    });
  }

  try {
    const row = await dbGet(
      `SELECT id, plan, status, expires_at, created_at
       FROM payments
       WHERE site_id = ?
         AND (
           plan = 'lifetime'
           OR (
             plan IN ('monthly', 'yearly')
             AND status IN ('active', 'trialing', 'past_due', 'paid')
             AND expires_at IS NOT NULL
             AND datetime(expires_at) > datetime('now')
           )
         )
       ORDER BY id DESC
       LIMIT 1`,
      [siteId]
    );

    return res.json({
      paid: !!row,
      plan: row?.plan || null,
      status: row?.status || null,
      expiresAt: row?.expires_at || null,
      createdAt: row?.created_at || null,
    });
  } catch (err) {
    console.error('Error checking payment:', err);
    return res.status(500).json({
      paid: false,
      message: 'Database error',
    });
  }
});

// -----------------------------
// Existing OAuth routes
// -----------------------------
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
        // console.log('Access token saved to database');
      }
    });

    await registerScriptForSite(accessToken, selectedSiteId);
    await applyRuntimeScripts(accessToken, selectedSiteId);

    return res.redirect(`https://${site.shortName}.design.webflow.com`);
  } catch (error) {
    // console.error('Error during OAuth process:', error);
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
  // console.log(`Server is running at http://localhost:${port}`);
});
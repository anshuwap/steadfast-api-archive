require("dotenv").config(); // This line loads the environment variables from the .env file

const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const axios = require("axios");
const sdk = require("dhanhq"); // Import the DhanHQ SDK
const fs = require("fs");
const csv = require("fast-csv");
const path = require("path");
const bodyParser = require("body-parser"); // Import body-parser

const app = express();

app.use(
  cors({
    origin: "http://localhost:5173", // Replace with your frontend's URL
    credentials: true,
  })
); // Enable CORS for your frontend's origin
app.use(express.json()); // To parse JSON bodies
app.use(bodyParser.json()); // Use body-parser middleware

// Broker API Keys & Client IDs
const DHAN_ACCESS_TOKEN = process.env.DHAN_API_TOKEN;
const DHAN_CLIENT_ID = String(process.env.DHAN_CLIENT_ID);
const FLATTRADE_CLIENT_ID = String(process.env.FLATTRADE_CLIENT_ID);
const FLATTRADE_API_KEY = String(process.env.FLATTRADE_API_KEY);
const FLATTRADE_API_SECRET = String(process.env.FLATTRADE_API_SECRET);

const client = new sdk.DhanHqClient({
  accessToken: DHAN_ACCESS_TOKEN,
  env: "DEV",
});

const brokers = [
  {
    brokerClientId: DHAN_CLIENT_ID,
    brokerName: "Dhan",
    appId: "dhan-app-id",
    apiKey: DHAN_ACCESS_TOKEN,
    apiSecret: DHAN_ACCESS_TOKEN,
    status: "Active",
    lastTokenGeneratedAt: "2023-10-01T12:00:00Z",
    addedAt: "2023-09-01T12:00:00Z",
  },
  {
    brokerClientId: FLATTRADE_CLIENT_ID,
    brokerName: "Flattrade",
    appId: "flattrade-app-id",
    apiKey: FLATTRADE_API_KEY,
    apiSecret: FLATTRADE_API_SECRET,
    status: "Active",
    lastTokenGeneratedAt: "2023-10-01T12:00:00Z",
    addedAt: "2023-09-01T12:00:00Z",
  },
  // Add more brokers as needed
];

app.get("/brokers", (req, res) => {
  res.json(brokers);
});

// Root route to prevent "Cannot GET /" error
app.get("/", (req, res) => {
  res.send("Welcome to the Proxy Server");
});

// Proxy configuration for Dhan API
app.use(
  "/api",
  createProxyMiddleware({
    target: "https://api.dhan.co",
    changeOrigin: true,
    pathRewrite: {
      "^/api": "",
    },
    onProxyReq: (proxyReq, req, res) => {
      // Log the headers to verify they are set correctly
      console.log("Proxying request to:", proxyReq.path);
      console.log("Request headers:", req.headers);
    },
    onProxyRes: (proxyRes, req, res) => {
      console.log("Received response with status:", proxyRes.statusCode);
    },
    onError: (err, req, res) => {
      console.error("Proxy Error:", err);
      res.status(500).json({ message: "Error in proxying request" });
    },
  })
);

// Custom route to handle API requests and bypass CORS
app.get("/fundlimit", async (req, res) => {
  try {
    const options = {
      method: "GET",
      url: "https://api.dhan.co/fundlimit",
      headers: {
        "access-token": process.env.DHAN_API_TOKEN, // Set the API token from environment variables
        Accept: "application/json",
      },
    };
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch fund limit:", error);
    res.status(500).json({ message: "Failed to fetch fund limit" });
  }
});

app.get("/symbols", (req, res) => {
  const { exchangeSymbol, masterSymbol } = req.query;
  const callStrikes = [];
  const putStrikes = [];
  const expiryDates = new Set();

  fs.createReadStream("./api-scrip-master.csv")
    .pipe(csv.parse({ headers: true }))
    .on("data", (row) => {
      if (
        row["SEM_EXM_EXCH_ID"] === exchangeSymbol &&
        row["SEM_TRADING_SYMBOL"].startsWith(masterSymbol + "-")
      ) {
        if (["OPTIDX", "OP"].includes(row["SEM_EXCH_INSTRUMENT_TYPE"])) {
          const strikeData = {
            tradingSymbol: row["SEM_TRADING_SYMBOL"],
            expiryDate: row["SEM_EXPIRY_DATE"],
            securityId: row["SEM_SMST_SECURITY_ID"],
          };
          if (row["SEM_OPTION_TYPE"] === "CE") {
            callStrikes.push(strikeData);
          } else if (row["SEM_OPTION_TYPE"] === "PE") {
            putStrikes.push(strikeData);
          }
          expiryDates.add(row["SEM_EXPIRY_DATE"]);
        }
      }
    })
    .on("end", () => {
      res.json({
        callStrikes,
        putStrikes,
        expiryDates: Array.from(expiryDates),
      });
    })
    .on("error", (error) => {
      res.status(500).json({ message: "Failed to process CSV file" });
    });
});

// Modified route to place an order to include securityId from the request
app.post("/placeOrder", async (req, res) => {
  const {
    brokerClientId,
    transactionType,
    exchangeSegment,
    productType,
    orderType,
    validity,
    tradingSymbol,
    securityId,
    quantity,
    price,
    drvExpiryDate,
    drvOptionType,
  } = req.body;

  const options = {
    method: "POST",
    url: "https://api.dhan.co/orders",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    data: {
      brokerClientId,
      transactionType,
      exchangeSegment,
      productType,
      orderType,
      validity,
      tradingSymbol,
      securityId,
      quantity,
      price,
      drvExpiryDate,
      drvOptionType,
    },
  };

  console.log("Sending request with body:", options.data);

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to place order:", error);
    res.status(500).json({ message: "Failed to place order" });
  }
});

// Route to handle the redirection and send the request_code back to the parent window
app.get("/redirect", (req, res) => {
  const requestCode = req.query.code;
  const client = req.query.client;

  console.log("Received request code:", requestCode);
  console.log("Received client:", client);

  if (!requestCode || !client) {
    res.status(400).send("Invalid request: Missing request code or client");
    return;
  }

  // Send the request_code back to the parent window
  res.send(`
    <script>
      console.log('Sending message to parent window');
      window.opener.postMessage('${req.protocol}://${req.get(
    "host"
  )}/redirect?request_code=${requestCode}&client=${client}', 'http://localhost:5173');
      window.close();
    </script>
  `);
});

// Example route using the DhanHQ SDK
app.get("/holdings", async (req, res) => {
  try {
    const response = await client.getHoldings();
    res.json(response);
  } catch (error) {
    console.error("Failed to fetch holdings:", error);
    res.status(500).json({ message: "Failed to fetch holdings" });
  }
});

// New endpoint to fetch Broker Client ID
app.get("/brokerClientId", (req, res) => {
  res.json({ brokerClientId: brokers.brokerClientId });
});

// New endpoint for Kill Switch
app.use(express.json()); // Make sure this middleware is used before any routes

app.post("/killSwitch", async (req, res) => {
  const killSwitchStatus = req.query.killSwitchStatus; // Get from query parameters

  console.log("Received killSwitchStatus:", killSwitchStatus); // Log the received status

  if (!["ACTIVATE", "DEACTIVATE"].includes(killSwitchStatus)) {
    return res.status(400).json({
      message:
        'Invalid killSwitchStatus value. Must be either "ACTIVATE" or "DEACTIVATE".',
    });
  }

  const options = {
    method: "POST",
    url: "https://api.dhan.co/killSwitch",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    params: {
      // Send as query parameters to the Dhan API
      killSwitchStatus,
    },
  };

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to activate Kill Switch:", error);
    res.status(500).json({
      message: "Failed to activate Kill Switch",
      error: error.response.data,
    });
  }
});

// Route to get orders
app.get("/getOrders", async (req, res) => {
  const options = {
    method: "GET",
    url: "https://api.dhan.co/orders",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN, // Set the API token from environment variables
      Accept: "application/json",
    },
  };

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch orders:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// New route to fetch positions
app.get("/positions", async (req, res) => {
  const options = {
    method: "GET",
    url: "https://api.dhan.co/positions",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN, // Use the API token from environment variables
      Accept: "application/json",
    },
  };

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch positions:", error);
    res.status(500).json({ message: "Failed to fetch positions" });
  }
});

// New route to cancel an order
app.delete("/cancelOrder", async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }

  const options = {
    method: "DELETE",
    url: `https://api.dhan.co/orders/${orderId}`,
    headers: {
      "access-token": process.env.DHAN_API_TOKEN,
      Accept: "application/json",
    },
  };

  try {
    const { data } = await axios.request(options);
    res.json(data);
  } catch (error) {
    console.error("Failed to cancel order:", error);
    res.status(500).json({ message: "Failed to cancel order" });
  }
});

// New route to handle the redirection and send the request_code back to the parent window
app.get("/?", (req, res) => {
  const { code, client } = req.query;
  if (code && client) {
    res.json({ code, client });
  } else {
    res.status(400).json({ message: "Invalid request" });
  }
});

// Serve the redirect.html file
// app.get('/redirect', (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'redirect.html'));
// });

// New route to proxy requests to Flattrade API
app.use(express.json());
app.post("/api/trade/apitoken", async (req, res) => {
  try {
    const response = await axios.post(
      "https://authapi.flattrade.in/trade/apitoken",
      req.body,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// New route to exchange request code for token for Flattrade API
app.post("/api/exchange-request-code-for-token", async (req, res) => {
  const { apiKey, requestCode, apiSecret } = req.body;

  if (!apiKey || !requestCode || !apiSecret) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const response = await axios.post(
    "https://authapi.flattrade.in/trade/apitoken",
    {
      api_key: apiKey,
      request_code: requestCode,
      api_secret: apiSecret,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  res.json(response.data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});



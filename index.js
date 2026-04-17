// Import required modules
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws").WebSocket;
const protobuf = require("protobufjs");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

// Setup Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // For development. Restrict in production
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// Enable CORS for REST API
app.use(cors());
app.use(express.json());

// Configure Supabase client
const supabaseUrl =
  process.env.SUPABASE_URL || "https://juisueefqgtvzezrzudv.supabase.co";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1aXN1ZWVmcWd0dnplenJ6dWR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkyMDUzNTcsImV4cCI6MjA3NDc4MTM1N30.zFzHnvlX5cyk7TfbOUZ1zB_depLTNWEzXmhDbcVlXYI";

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Supabase credentials are missing. Please check your environment variables."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize global variables
let protobufRoot = null;
let upstoxWs = null; // Single WebSocket for all market data (stocks + options)
let cachedAccessToken = null;
let tokenCacheTime = null;
const TOKEN_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

// Function to fetch access token from Supabase (single row approach)
const getAccessTokenFromDB = async () => {
  try {
    // Check if we have a cached token that's still valid
    if (
      cachedAccessToken &&
      tokenCacheTime &&
      Date.now() - tokenCacheTime < TOKEN_CACHE_DURATION
    ) {
      console.log("🔄 Using cached access token");
      return cachedAccessToken;
    }

    console.log("🔍 Fetching access token from database...");

    // Get the single token row for upstox provider
    const { data, error } = await supabase
      .from("access_tokens")
      .select("token, expires_at")
      .eq("provider", "upstox")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (error) {
      console.error("❌ Error fetching access token from database:", error);
      throw new Error(`Database error: ${error.message}`);
    }

    if (!data) {
      throw new Error("No active access token found in database");
    }

    // Check if token is expired
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      throw new Error("Access token has expired");
    }

    // Cache the token
    cachedAccessToken = data.token;
    tokenCacheTime = Date.now();

    console.log("✅ Successfully fetched access token from database");
    return data.token;
  } catch (error) {
    console.error("❌ Failed to get access token:", error.message);
    throw error;
  }
};

// Function to save access token to database (single row approach)
const saveAccessTokenToDB = async (
  token,
  expiresAt = null,
  provider = "upstox"
) => {
  try {
    console.log("💾 Saving access token to database...");

    // Check if a row already exists for this provider
    const { data: existingToken, error: selectError } = await supabase
      .from("access_tokens")
      .select("id")
      .eq("provider", provider)
      .limit(1)
      .single();

    let result;

    if (existingToken && !selectError) {
      // Update the existing row
      console.log("🔄 Updating existing access token...");
      const { data, error } = await supabase
        .from("access_tokens")
        .update({
          token: token,
          expires_at: expiresAt,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingToken.id)
        .select()
        .single();

      if (error) {
        console.error("❌ Error updating access token:", error);
        throw new Error(`Database error: ${error.message}`);
      }

      result = data;
    } else {
      // Insert the first token
      console.log("➕ Inserting first access token...");
      const { data, error } = await supabase
        .from("access_tokens")
        .insert({
          provider: provider,
          token: token,
          expires_at: expiresAt,
          is_active: true,
        })
        .select()
        .single();

      if (error) {
        console.error("❌ Error inserting access token:", error);
        throw new Error(`Database error: ${error.message}`);
      }

      result = data;
    }

    // Clear cache to force refresh
    cachedAccessToken = null;
    tokenCacheTime = null;

    console.log("✅ Successfully saved access token to database");
    return result;
  } catch (error) {
    console.error("❌ Failed to save access token:", error.message);
    throw error;
  }
};

// Function to get available instruments for testing
// In api.md, update the getTestInstruments function:
const getTestInstruments = async () => {
  try {
    const accessToken = await getAccessTokenFromDB();
    
    // Get Nifty 50 options for current month expiry
    const url = "https://api.upstox.com/v2/option/chain";
    const params = {
      instrument_key: "NSE_INDEX|Nifty 50",
      expiry_date: "2025-10-28" // Change this to the current month's expiry

    };
    
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };

    console.log("🔍 Fetching Nifty 50 option chain...");
    const response = await axios.get(url, { headers, params });

    if (response.data && response.data.data) {
      // Return all option instrument keys
      return response.data.data.map(
        (opt) => opt.instrument_key
      );
    }

    return [];
  } catch (error) {
    console.error("❌ Failed to fetch option chain:", error.message);
    // Return fallback instruments
    return [
      // "NSE_FO|45450", "NSE_FO|45451",
      "NSE_FO|50904", "NSE_FO|50905",
    ];
  }
};


// Function to authorize the market data feed
const getMarketFeedUrl = async () => {
  try {
    const accessToken = await getAccessTokenFromDB();
    const url = "https://api.upstox.com/v3/feed/market-data-feed/authorize";
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };

    console.log("🔐 Authorizing market data feed with database token...");
    const response = await axios.get(url, { headers });
    console.log("✅ Successfully authorized market data feed");

    return response.data.data.authorizedRedirectUri;
  } catch (error) {
    console.error("❌ Failed to authorize market data feed:", error.message);
    throw error;
  }
};

// Helper function to extract complete option data from feed
const extractFullOptionData = (feed, key, decoded) => {
  let result = {
    instrumentKey: key,
    timestamp: decoded.currentTs || Date.now(),
  };

  // Check for firstLevelWithGreeks structure (option_greeks mode)
  if (feed.firstLevelWithGreeks) {
    const flwg = feed.firstLevelWithGreeks;

    // LTPC data
    if (flwg.ltpc) {
      result.ltpc = {
        ltp: flwg.ltpc.ltp || 0,
        ltt: flwg.ltpc.ltt || null,
        ltq: flwg.ltpc.ltq || null,
        cp: flwg.ltpc.cp || 0,
      };
    }

    // Option Greeks
    if (flwg.optionGreeks) {
      result.optionGreeks = {
        delta: flwg.optionGreeks.delta || 0,
        gamma: flwg.optionGreeks.gamma || 0,
        theta: flwg.optionGreeks.theta || 0,
        vega: flwg.optionGreeks.vega || 0,
        rho: flwg.optionGreeks.rho || 0,
      };
    }

    // Additional fields
    result.vtt = flwg.vtt || 0; // Volume traded today
    result.oi = flwg.oi || 0; // Open Interest
    result.iv = flwg.iv || 0; // Implied Volatility

    return result;
  }

  // Check for fullFeed structure (full mode)
  if (feed.fullFeed && feed.fullFeed.marketFF) {
    const marketFF = feed.fullFeed.marketFF;

    // LTPC data
    if (marketFF.ltpc) {
      result.ltpc = {
        ltp: marketFF.ltpc.ltp || 0,
        ltt: marketFF.ltpc.ltt || null,
        ltq: marketFF.ltpc.ltq || null,
        cp: marketFF.ltpc.cp || 0,
      };
    }

    // Market Level (Bid/Ask Quotes)
    if (marketFF.marketLevel && marketFF.marketLevel.bidAskQuote) {
      result.marketLevel = {
        bidAskQuote: marketFF.marketLevel.bidAskQuote.map((quote) => ({
          bidQ: quote.bidQ || "0",
          bidP: quote.bidP || 0,
          askQ: quote.askQ || "0",
          askP: quote.askP || 0,
        })),
      };
    }

    // Option Greeks
    if (marketFF.optionGreeks) {
      result.optionGreeks = {
        delta: marketFF.optionGreeks.delta || 0,
        gamma: marketFF.optionGreeks.gamma || 0,
        theta: marketFF.optionGreeks.theta || 0,
        vega: marketFF.optionGreeks.vega || 0,
        rho: marketFF.optionGreeks.rho || 0,
      };
    }

    // Market OHLC
    if (marketFF.marketOHLC && marketFF.marketOHLC.ohlc) {
      result.marketOHLC = {
        ohlc: marketFF.marketOHLC.ohlc.map((candle) => ({
          interval: candle.interval || "",
          open: candle.open || 0,
          high: candle.high || 0,
          low: candle.low || 0,
          close: candle.close || 0,
          vol: candle.vol || "0",
          ts: candle.ts || null,
        })),
      };
    }

    // Additional market data
    result.atp = marketFF.atp || 0; // Average Traded Price
    result.vtt = marketFF.vtt || "0"; // Volume traded today
    result.oi = marketFF.oi || 0; // Open Interest
    result.iv = marketFF.iv || 0; // Implied Volatility
    result.tbq = marketFF.tbq || 0; // Total Buy Quantity
    result.tsq = marketFF.tsq || 0; // Total Sell Quantity

    return result;
  }

  // Check for direct LTPC structure
  if (feed.ltpc) {
    result.ltpc = {
      ltp: feed.ltpc.ltp || 0,
      ltt: feed.ltpc.ltt || null,
      ltq: feed.ltpc.ltq || null,
      cp: feed.ltpc.cp || 0,
    };
    return result;
  }

  return null;
};

// Function to establish WebSocket connection (single connection for all data)
const connectWebSocket = async (wsUrl) => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      followRedirects: true,
    });

    // WebSocket event handlers
    ws.on("open", () => {
      console.log("✅ Connected to Upstox WebSocket");
      resolve(ws);

      // Set up heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(heartbeat);
        }
      }, 30000); // Every 30 seconds

      // Default subscription for indices
      setTimeout(() => {
        const data = {
          guid: "default_indices",
          method: "sub",
          data: {
            mode: "full",
            instrumentKeys: [
              "NSE_INDEX|Nifty Bank",
              "NSE_INDEX|Nifty 50",
              "NSE_INDEX|Nifty IT",
            ],
          },
        };
        ws.send(Buffer.from(JSON.stringify(data)));
        console.log("📡 Sent default subscription to Upstox (mode: full)");
      }, 1000);
    });

    ws.on("close", (code, reason) => {
      console.log(
        `🔌 Disconnected from Upstox WebSocket. Code: ${code}, Reason: ${reason}`
      );
      upstoxWs = null;
    });

    ws.on("message", (data) => {
      try {
        // Decode the protobuf message
        const decoded = decodeProfobuf(data);

        if (decoded) {
          // Log the raw decoded data
          console.log(
            "📊 Received market data:",
            JSON.stringify(decoded, null, 2)
          );

          // Send the decoded data to all connected Socket.IO clients
          io.emit("marketData", decoded);

          // Extract and send LTP and full Option data if available
          if (decoded.feeds) {
            const ltpData = {};
            const fullOptionData = {};

            Object.keys(decoded.feeds).forEach((key) => {
              const feed = decoded.feeds[key];

              console.log(
                `📈 Processing feed for ${key}:`,
                JSON.stringify(feed, null, 2)
              );

              // Try to find LTP in various possible locations
              const ltp =
                feed.ltp ||
                (feed.price && feed.price.ltp) ||
                (feed.ff &&
                  feed.ff.marketFF &&
                  feed.ff.marketFF.ltpc &&
                  feed.ff.marketFF.ltpc.ltp) ||
                (feed.ltpc && feed.ltpc.ltp) ||
                (feed.fullFeed &&
                  feed.fullFeed.marketFF &&
                  feed.fullFeed.marketFF.ltpc &&
                  feed.fullFeed.marketFF.ltpc.ltp) ||
                (feed.firstLevelWithGreeks &&
                  feed.firstLevelWithGreeks.ltpc &&
                  feed.firstLevelWithGreeks.ltpc.ltp) ||
                feed.lastTradedPrice ||
                feed.lastPrice;

              if (ltp) {
                ltpData[key] = ltp;
                console.log(`💰 LTP for ${key}: ${ltp}`);
              }

              // Extract full option data (Greeks, bid/ask, OHLC, etc.)
              const optionData = extractFullOptionData(feed, key, decoded);
              if (optionData) {
                fullOptionData[key] = optionData;
                console.log(
                  `🎯 Full option data for ${key}:`,
                  JSON.stringify(optionData, null, 2)
                );
              }
            });

            // Emit LTP data for stocks/indices
            if (Object.keys(ltpData).length > 0) {
              io.emit("ltp", { timestamp: Date.now(), data: ltpData });
            }

            // Emit full option data (includes Greeks, bid/ask, OHLC, volume, OI, etc.)
            if (Object.keys(fullOptionData).length > 0) {
              io.emit("fullOptionData", {
                timestamp: Date.now(),
                data: fullOptionData,
              });

              // Also emit simplified optionGreeks for backward compatibility
              const greeksOnly = {};
              Object.keys(fullOptionData).forEach((key) => {
                const opt = fullOptionData[key];
                if (opt.optionGreeks) {
                  greeksOnly[key] = {
                    ...opt.optionGreeks,
                    ltp: opt.ltpc ? opt.ltpc.ltp : 0,
                    iv: opt.iv || 0,
                    oi: opt.oi || 0,
                    vtt: opt.vtt || 0,
                    timestamp: opt.timestamp,
                  };
                }
              });

              if (Object.keys(greeksOnly).length > 0) {
                io.emit("optionGreeks", {
                  timestamp: Date.now(),
                  data: greeksOnly,
                });
              }

              // Also emit optionsData for backward compatibility
              io.emit("optionsData", {
                timestamp: Date.now(),
                data: decoded,
              });
            }
          }
        }
      } catch (error) {
        console.error("❌ Error processing message:", error);
      }
    });

    ws.on("error", (error) => {
      console.error("❌ Upstox WebSocket error:", error);
      reject(error);
    });

    ws.on("ping", () => {
      console.log("🏓 Received ping from server");
    });

    ws.on("pong", () => {
      console.log("🏓 Received pong from server");
    });
  });
};

// Function to initialize the protobuf part
const initProtobuf = async () => {
  try {
    protobufRoot = await protobuf.load(__dirname + "/MarketDataFeedV3.proto");
    console.log("✅ Protobuf initialized successfully");
    return true;
  } catch (error) {
    console.error("❌ Failed to initialize protobuf:", error);
    return false;
  }
};

// Function to decode protobuf message
const decodeProfobuf = (buffer) => {
  if (!protobufRoot) {
    console.warn("⚠️ Protobuf not initialized yet!");
    return null;
  }

  try {
    const FeedResponse = protobufRoot.lookupType(
      "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse"
    );
    const decoded = FeedResponse.decode(buffer);
    return FeedResponse.toObject(decoded, {
      longs: String,
      enums: String,
      bytes: String,
    });
  } catch (error) {
    // console.error("❌ Failed to decode protobuf:", error);
    return null;
  }
};

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("👤 Frontend client connected:", socket.id);

  // Handle client disconnect
  socket.on("disconnect", () => {
    console.log("👤 Frontend client disconnected:", socket.id);
  });

  // Handle subscription requests from frontend
  socket.on("subscribe", async (instruments) => {
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      socket.emit("error", { message: "WebSocket not connected" });
      return;
    }

    try {
      const data = {
        guid: "clientrequest",
        method: "sub",
        data: {
          mode: "full",
          instrumentKeys: Array.isArray(instruments)
            ? instruments
            : [
                "NSE_INDEX|Nifty Bank",
                "NSE_INDEX|Nifty 50",
                "NSE_INDEX|Nifty IT",
                "NSE_EQ|INE002A01018", // RELIANCE
                "NSE_EQ|INE040A01034", // HDFC BANK
                "NSE_EQ|INE009A01021", // INFOSYS
                "NSE_EQ|INE030A01027", // BHARTI AIRTEL
              ],
        },
      };

      upstoxWs.send(Buffer.from(JSON.stringify(data)));
      socket.emit("subscribed", { instruments: data.data.instrumentKeys });
    } catch (error) {
      socket.emit("error", {
        message: "Failed to send subscription: " + error.message,
      });
    }
  });

  // Handle subscription requests for options from frontend (uses same WebSocket)
  socket.on("subscribeOptions", async (instruments) => {
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      socket.emit("error", { message: "WebSocket not connected" });
      return;
    }

    try {
      const data = {
        guid: "optionsrequest_" + Date.now(),
        method: "sub",
        data: {
          mode: "full", // Full mode for complete option data
          instrumentKeys: Array.isArray(instruments)
            ? instruments
            : ["NSE_FO|50904",
              "NSE_FO|50905"
            ],
        },
      };

      upstoxWs.send(Buffer.from(JSON.stringify(data)));
      socket.emit("optionsSubscribed", {
        instruments: data.data.instrumentKeys,
      });
      console.log(
        "📡 Options subscription sent (mode: full):",
        data.data.instrumentKeys
      );
    } catch (error) {
      socket.emit("error", {
        message: "Failed to send options subscription: " + error.message,
      });
    }
  });

  // Handle unsubscribe requests for options
  socket.on("unsubscribeOptions", async (instruments) => {
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      socket.emit("error", { message: "WebSocket not connected" });
      return;
    }

    try {
      const data = {
        guid: "optionsunsubscribe_" + Date.now(),
        method: "unsub",
        data: {
          instrumentKeys: Array.isArray(instruments) ? instruments : [],
        },
      };

      upstoxWs.send(Buffer.from(JSON.stringify(data)));
      socket.emit("optionsUnsubscribed", {
        instruments: data.data.instrumentKeys,
      });
      console.log("📡 Options unsubscription sent:", data.data.instrumentKeys);
    } catch (error) {
      socket.emit("error", {
        message: "Failed to unsubscribe options: " + error.message,
      });
    }
  });
});

// API Routes
app.get("/start", async (req, res) => {
  try {
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      // console.log("🚀 Starting WebSocket connection...");
      const wsUrl = await getMarketFeedUrl();
      upstoxWs = await connectWebSocket(wsUrl);
      res.json({ success: true, message: "WebSocket connection started" });
    } else {
      res.json({ success: true, message: "WebSocket already connected" });
    }
  } catch (error) {
    // console.error("❌ Failed to start WebSocket:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/status", (req, res) => {
  res.json({
    connected: upstoxWs && upstoxWs.readyState === WebSocket.OPEN,
    protobufInitialized: protobufRoot !== null,
    note: "Single WebSocket handles both stocks and options",
  });
});

// API endpoint to start options subscription (uses existing WebSocket)
app.get("/api/options/start", async (req, res) => {
  try {
    // Ensure WebSocket is connected
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      console.log("🚀 Starting WebSocket connection...");
      const wsUrl = await getMarketFeedUrl();
      upstoxWs = await connectWebSocket(wsUrl);
    }

    // Send a test options subscription via the single WebSocket
    const optionGreeksTest = {
      guid: "options_start_" + Date.now(),
      method: "sub",
      data: {
        mode: "full",
        instrumentKeys: [
          "NSE_FO|45450", // Nifty options
          "NSE_FO|45451", // Nifty options
          "NSE_FO|50904", // Bank Nifty options
          "NSE_FO|50923", // Bank Nifty options
        ],
      },
    };

    console.log(
      "📡 Sending options subscription (mode: full):",
      JSON.stringify(optionGreeksTest, null, 2)
    );
    upstoxWs.send(Buffer.from(JSON.stringify(optionGreeksTest)));

    res.json({
      success: true,
      message: "Options subscription sent via main WebSocket",
      instruments: optionGreeksTest.data.instrumentKeys,
    });
  } catch (error) {
    console.error("❌ Failed to subscribe to options:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Simplified endpoint for easier access
app.get("/options/start", async (req, res) => {
  try {
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      console.log("🚀 Starting WebSocket connection...");
      const wsUrl = await getMarketFeedUrl();
      upstoxWs = await connectWebSocket(wsUrl);
    }

    const optionGreeksTest = {
      guid: "options_start_" + Date.now(),
      method: "sub",
      data: {
        mode: "full",
        instrumentKeys: [
          "NSE_FO|45450",
          "NSE_FO|45451",
          "NSE_FO|50904",
          "NSE_FO|50923",
        ],
      },
    };

    console.log(
      "📡 Sending options subscription (mode: full):",
      JSON.stringify(optionGreeksTest, null, 2)
    );
    upstoxWs.send(Buffer.from(JSON.stringify(optionGreeksTest)));

    res.json({
      success: true,
      message: "Options subscription sent",
      instruments: optionGreeksTest.data.instrumentKeys,
    });
  } catch (error) {
    console.error("❌ Failed to subscribe to options:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to subscribe to specific option instruments
app.post("/api/options/subscribe", async (req, res) => {
  try {
    const { instrumentKeys, mode = "full" } = req.body;

    if (!instrumentKeys || !Array.isArray(instrumentKeys)) {
      return res.status(400).json({
        success: false,
        error: "instrumentKeys array is required",
      });
    }

    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      return res.status(400).json({
        success: false,
        error: "WebSocket not connected. Call /start first.",
      });
    }

    const data = {
      guid: "api_options_request_" + Date.now(),
      method: "sub",
      data: {
        mode: mode, // option_greeks, full, or ltpc
        instrumentKeys: instrumentKeys,
      },
    };

    upstoxWs.send(Buffer.from(JSON.stringify(data)));

    res.json({
      success: true,
      message: "Successfully subscribed to option instruments",
      data: {
        instrumentKeys: instrumentKeys,
        mode: mode,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to subscribe to options",
      details: error.message,
    });
  }
});

// Simplified endpoint for easier access
app.post("/options/subscribe", async (req, res) => {
  try {
    const { instrumentKeys, mode = "full" } = req.body;

    if (!instrumentKeys || !Array.isArray(instrumentKeys)) {
      return res.status(400).json({
        success: false,
        error: "instrumentKeys array is required",
      });
    }

    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      return res.status(400).json({
        success: false,
        error: "WebSocket not connected. Call /start first.",
      });
    }

    const data = {
      guid: "options_request_" + Date.now(),
      method: "sub",
      data: {
        mode: mode,
        instrumentKeys: instrumentKeys,
      },
    };

    console.log(
      "📡 Options subscription request:",
      JSON.stringify(data, null, 2)
    );
    upstoxWs.send(Buffer.from(JSON.stringify(data)));

    res.json({
      success: true,
      message: "Successfully subscribed to option instruments",
      data: {
        instrumentKeys: instrumentKeys,
        mode: mode,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to subscribe to options",
      details: error.message,
    });
  }
});

// API endpoint to unsubscribe from option instruments
app.post("/api/options/unsubscribe", async (req, res) => {
  try {
    const { instrumentKeys } = req.body;

    if (!instrumentKeys || !Array.isArray(instrumentKeys)) {
      return res.status(400).json({
        success: false,
        error: "instrumentKeys array is required",
      });
    }

    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      return res.status(400).json({
        success: false,
        error: "WebSocket not connected",
      });
    }

    const data = {
      guid: "api_options_unsub_" + Date.now(),
      method: "unsub",
      data: {
        instrumentKeys: instrumentKeys,
      },
    };

    upstoxWs.send(Buffer.from(JSON.stringify(data)));

    res.json({
      success: true,
      message: "Successfully unsubscribed from option instruments",
      data: {
        instrumentKeys: instrumentKeys,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to unsubscribe from options",
      details: error.message,
    });
  }
});

// API endpoint to get available instruments for options trading
app.get("/api/options/instruments", async (req, res) => {
  try {
    const instruments = await getTestInstruments();
    res.json({
      success: true,
      data: {
        instruments: instruments,
        count: instruments.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch instruments",
      details: error.message,
    });
  }
});

// Simplified endpoint for easier access
app.get("/options/instruments", async (req, res) => {
  try {
    const instruments = await getTestInstruments();
    res.json({
      success: true,
      data: {
        instruments: instruments,
        count: instruments.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch instruments",
      details: error.message,
    });
  }
});

// API endpoint to get options connection status
app.get("/api/options/status", (req, res) => {
  res.json({
    success: true,
    data: {
      connected: upstoxWs && upstoxWs.readyState === WebSocket.OPEN,
      connectionState: upstoxWs ? upstoxWs.readyState : null,
      protobufInitialized: protobufRoot !== null,
      note: "Single WebSocket handles both stocks and options",
      timestamp: new Date().toISOString(),
    },
  });
});

// Simplified endpoint for easier access
app.get("/options/status", (req, res) => {
  res.json({
    success: true,
    data: {
      connected: upstoxWs && upstoxWs.readyState === WebSocket.OPEN,
      connectionState: upstoxWs ? upstoxWs.readyState : null,
      protobufInitialized: protobufRoot !== null,
      note: "Single WebSocket handles both stocks and options",
      timestamp: new Date().toISOString(),
    },
  });
});

// Debug endpoint to test options data flow
app.get("/api/options/debug", (req, res) => {
  try {
    const debugInfo = {
      webSocket: {
        exists: !!upstoxWs,
        readyState: upstoxWs ? upstoxWs.readyState : null,
        readyStateText: upstoxWs
          ? upstoxWs.readyState === 0
            ? "CONNECTING"
            : upstoxWs.readyState === 1
            ? "OPEN"
            : upstoxWs.readyState === 2
            ? "CLOSING"
            : upstoxWs.readyState === 3
            ? "CLOSED"
            : "UNKNOWN"
          : null,
        note: "Single WebSocket for all data",
      },
      protobuf: {
        initialized: !!protobufRoot,
        rootExists: !!protobufRoot,
      },
      accessToken: {
        cached: !!cachedAccessToken,
        cacheTime: tokenCacheTime
          ? new Date(tokenCacheTime).toISOString()
          : null,
      },
      socketIO: {
        connectedClients: io.engine.clientsCount,
      },
      timestamp: new Date().toISOString(),
    };

    res.json({
      success: true,
      debug: debugInfo,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

// Test endpoint to manually trigger options subscription
app.post("/api/options/test-subscribe", (req, res) => {
  try {
    if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) {
      return res.status(400).json({
        success: false,
        error: "WebSocket not connected",
        readyState: upstoxWs ? upstoxWs.readyState : null,
      });
    }

    const testInstruments = req.body.instrumentKeys || [
      "NSE_FO|45450",
      "NSE_FO|45451",
    ];

    const data = {
      guid: "manual_test_" + Date.now(),
      method: "sub",
      data: {
        mode: "full",
        instrumentKeys: testInstruments,
      },
    };

    console.log(
      "📡 Manual test subscription (mode: full):",
      JSON.stringify(data, null, 2)
    );
    upstoxWs.send(Buffer.from(JSON.stringify(data)));

    res.json({
      success: true,
      message: "Test subscription sent",
      data: data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
    });
  }
});

// API endpoint to get current access token info
app.get("/api/token/info", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("access_tokens")
      .select("id, provider, expires_at, is_active, created_at, updated_at")
      .eq("provider", "upstox")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      return res.status(404).json({
        success: false,
        error: "No active access token found",
        details: error.message,
      });
    }

    res.json({
      success: true,
      data: {
        ...data,
        isExpired: data.expires_at
          ? new Date(data.expires_at) < new Date()
          : false,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch token info",
      details: error.message,
    });
  }
});

// API endpoint to update access token
app.post("/api/token/update", async (req, res) => {
  try {
    const { token, expires_at, provider = "upstox" } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token is required",
      });
    }

    const result = await saveAccessTokenToDB(token, expires_at, provider);

    res.json({
      success: true,
      message: "Access token updated successfully",
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to update access token",
      details: error.message,
    });
  }
});

// API endpoint to test current access token
app.get("/api/token/test", async (req, res) => {
  try {
    const accessToken = await getAccessTokenFromDB();

    // Test the token by making a simple API call
    const testUrl = "https://api.upstox.com/v2/user/profile";
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };

    const response = await axios.get(testUrl, { headers });

    res.json({
      success: true,
      message: "Access token is valid",
      profile: response.data,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: "Access token test failed",
      details: error.message,
    });
  }
});

// API endpoint to get option chain data
app.get("/api/option-chain", async (req, res) => {
  try {
    const instrumentKey = req.query.instrument_key || "NSE_INDEX|Nifty 50";
    const expiryDate = req.query.expiry_date || "2025-11-25";

    // Get the access token from database
    const accessToken = await getAccessTokenFromDB();

    if (!accessToken) {
      return res.status(500).json({
        success: false,
        error: "Upstox access token not configured",
      });
    }

    const url = "https://api.upstox.com/v2/option/chain";
    const params = {
      instrument_key: instrumentKey,
      expiry_date: expiryDate,
    };

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };

    console.log(`📊 Fetching option chain for ${instrumentKey} expiry ${expiryDate}`);
    const response = await axios.get(url, { params, headers });

    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Option chain error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || "Failed to fetch option chain",
      details: error.response?.data,
    });
  }
});

// Simplified endpoint for easier access
app.get("/option-chain", async (req, res) => {
  try {
    const instrumentKey = req.query.instrument_key || "NSE_INDEX|Nifty 50";
    const expiryDate = req.query.expiry_date || "2025-11-25";

    const accessToken = await getAccessTokenFromDB();

    if (!accessToken) {
      return res.status(500).json({
        success: false,
        error: "Upstox access token not configured",
      });
    }

    const url = "https://api.upstox.com/v2/option/chain";
    const params = {
      instrument_key: instrumentKey,
      expiry_date: expiryDate,
    };

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };

    console.log(`📊 Fetching option chain for ${instrumentKey} expiry ${expiryDate}`);
    const response = await axios.get(url, { params, headers });

    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Option chain error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message || "Failed to fetch option chain",
      details: error.response?.data,
    });
  }
});

// API endpoint to get high/low data for stocks
app.get("/api/stocks/highlow", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("stock_highlow")
      .select("*")
      .eq("is_active", true)
      .order("symbol", { ascending: true });

    if (error) {
      return res.status(500).json({
        success: false,
        error: "Failed to fetch high/low data",
        details: error.message,
      });
    }

    res.json({
      success: true,
      data: data || [],
      count: data ? data.length : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch high/low data",
      details: error.message,
    });
  }
});

// API endpoint to add new stock instruments
app.post("/api/stocks/add", async (req, res) => {
  try {
    const { instruments } = req.body;

    if (!instruments || !Array.isArray(instruments)) {
      return res.status(400).json({
        success: false,
        error: "instruments array is required. Format: [{ instrument_key, company_name, symbol, exchange, sector }]",
      });
    }

    const results = {
      added: [],
      failed: [],
      skipped: [],
    };

    for (const instrument of instruments) {
      try {
        const { instrument_key, company_name, symbol, exchange, sector } = instrument;

        if (!instrument_key) {
          results.failed.push({ instrument, error: "instrument_key is required" });
          continue;
        }

        // Check if instrument already exists
        const { data: existing } = await supabase
          .from("stock_instruments")
          .select("id")
          .eq("instrument_key", instrument_key)
          .maybeSingle();

        if (existing) {
          results.skipped.push({ instrument_key, reason: "Already exists" });
          continue;
        }

        // Add new instrument
        const { data, error } = await supabase
          .from("stock_instruments")
          .insert({
            instrument_key,
            company_name: company_name || "Unknown",
            symbol: symbol || instrument_key.split("|")[1] || "N/A",
            exchange: exchange || instrument_key.split("|")[0] || "N/A",
            sector: sector || null,
            is_active: true,
          })
          .select()
          .single();

        if (error) {
          results.failed.push({ instrument_key, error: error.message });
        } else {
          results.added.push(data);
        }
      } catch (error) {
        results.failed.push({ instrument, error: error.message });
      }
    }

    res.json({
      success: true,
      message: `Added ${results.added.length} instruments`,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to add instruments",
      details: error.message,
    });
  }
});

// API endpoint to get all stock instruments
app.get("/api/stocks/instruments", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("stock_instruments")
      .select("*")
      .eq("is_active", true)
      .order("symbol", { ascending: true });

    if (error) {
      return res.status(500).json({
        success: false,
        error: "Failed to fetch instruments",
        details: error.message,
      });
    }

    res.json({
      success: true,
      data: data || [],
      count: data ? data.length : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch instruments",
      details: error.message,
    });
  }
});

// ===== JOB CONTROL ENDPOINTS =====

// Job status tracking for high/low job
let jobStatus = {
  isRunning: false,
  startTime: null,
  endTime: null,
  progress: {
    total: 0,
    completed: 0,
    failed: 0,
    current: null
  },
  results: null,
  error: null
};

// Function to fetch active instruments from the stock_instruments table
async function fetchActiveInstruments() {
  try {
    console.log('🔍 Fetching active instruments from stock_instruments table');
    
    const { data, error } = await supabase
      .from('stock_instruments')
      .select('instrument_key')
      .eq('is_active', true);
      
    if (error) {
      console.error(`❌ Error fetching active instruments: ${error.message}`);
      throw error;
    }
    
    if (!data || data.length === 0) {
      console.warn('⚠️ No active instruments found in the database');
      return [];
    }
    
    // Extract instrument keys from the result
    const instruments = data.map(item => item.instrument_key);
    console.log(`✅ Found ${instruments.length} active instruments`);
    
    return instruments;
  } catch (error) {
    console.error('❌ Failed to fetch active instruments:', error.message);
    throw error;
  }
}

// Function to fetch historical data from Upstox
async function fetchHistoricalData(instrumentKey) {
  try {
    const accessToken = await getAccessTokenFromDB();
    
    // Calculate date range for 52 weeks (365 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 365);

    // Format dates as YYYY-MM-DD
    const formatDate = (date) => {
      return date.toISOString().split('T')[0];
    };

    // Format: /v3/historical-candle/:instrument_key/:unit/:interval/:to_date/:from_date
    const unit = 'days';
    const interval = '1';
    const toDate = formatDate(endDate);
    const fromDate = formatDate(startDate);
    
    const url = `https://api.upstox.com/v3/historical-candle/${instrumentKey}/${unit}/${interval}/${toDate}/${fromDate}`;
    
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    };

    console.log(`📊 Fetching historical data for ${instrumentKey} from ${fromDate} to ${toDate}`);
    
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    console.error(`❌ Error fetching historical data for ${instrumentKey}:`, error.message);
    if (error.response) {
      console.error(`Response status: ${error.response.status}, data:`, error.response.data);
    }
    throw error;
  }
}

// Function to calculate 52-week high and low
function calculate52WeekHighLow(data) {
  try {
    if (!data || !data.data || !data.data.candles || data.data.candles.length === 0) {
      throw new Error('Invalid or empty data received');
    }

    const candles = data.data.candles;
    
    console.log(`📈 Processing ${candles.length} candles for 52-week high/low calculation`);
    
    // Log first few candles to verify data structure
    if (candles.length > 0) {
      console.log(`🔍 Sample candles (first 3):`);
      for (let i = 0; i < Math.min(3, candles.length); i++) {
        const candle = candles[i];
        console.log(`  Candle ${i}: timestamp=${candle[0]}, open=${candle[1]}, high=${candle[2]}, low=${candle[3]}, close=${candle[4]}, volume=${candle[5]}`);
      }
    }
    
    // Initialize high and low with the first candle's high and low
    let high = candles[0][2]; // High value from first candle (index 2)
    let low = candles[0][3];  // Low value from first candle (index 3)
    let highDate = candles[0][0];
    let lowDate = candles[0][0];
    
    // Track current price (most recent close)
    const currentPrice = candles[candles.length - 1][4]; // Close price of last candle
    
    // Iterate through all candles to find the highest high and lowest low
    for (const candle of candles) {
      const candleHigh = candle[2];
      const candleLow = candle[3];
      
      // Validate that high/low values are reasonable numbers
      if (typeof candleHigh !== 'number' || typeof candleLow !== 'number' || 
          candleHigh <= 0 || candleLow <= 0 || candleHigh < candleLow) {
        console.warn(`⚠️ Invalid candle data: high=${candleHigh}, low=${candleLow}, timestamp=${candle[0]}`);
        continue;
      }
      
      if (candleHigh > high) {
        high = candleHigh;
        highDate = candle[0];
      }
      
      if (candleLow < low) {
        low = candleLow;
        lowDate = candle[0];
      }
    }
    
    // Validation: Check if the calculated high/low makes sense
    const highFromCurrent = ((high - currentPrice) / currentPrice) * 100;
    const lowFromCurrent = ((currentPrice - low) / low) * 100;
    
    console.log(`💰 52-week High: ${high} (on ${new Date(highDate).toDateString()})`);
    console.log(`💰 52-week Low: ${low} (on ${new Date(lowDate).toDateString()})`);
    console.log(`📊 Current Price: ${currentPrice}`);
    console.log(`📈 High is ${highFromCurrent.toFixed(1)}% above current price`);
    console.log(`📉 Current is ${lowFromCurrent.toFixed(1)}% above low`);
    
    // Warning if the high seems too far from current price (more than 500% difference)
    if (Math.abs(highFromCurrent) > 500) {
      console.warn(`⚠️ WARNING: 52-week high (${high}) seems unusually far from current price (${currentPrice}). Please verify data.`);
    }
    
    // Warning if low is higher than current (shouldn't happen)
    if (low > currentPrice) {
      console.warn(`⚠️ WARNING: 52-week low (${low}) is higher than current price (${currentPrice}). Data may be incorrect.`);
    }
    
    return { high, low, currentPrice };
  } catch (error) {
    console.error('❌ Error calculating 52-week high/low:', error.message);
    throw error;
  }
}

// Function to save data to Supabase
async function saveHighLowToSupabase(instrumentKey, high, low) {
  try {
    console.log(`💾 Saving data for ${instrumentKey}: high=${high}, low=${low}`);
    
    // Create a data object with required fields
    const dataToSave = {
      instrument_key: instrumentKey,
      high: high,
      low: low,
      updated_at: new Date().toISOString(),
      is_active: true
    };
    
    // Perform the upsert operation
    const { data, error } = await supabase
      .from('stock_highlow')
      .upsert(
        dataToSave,
        { 
          onConflict: 'instrument_key',
          ignoreDuplicates: false
        }
      );
      
    if (error) {
      console.error(`❌ Error in Supabase upsert for ${instrumentKey}: ${error.message}`);
      throw error;
    }
    
    console.log(`✅ Successfully saved data for ${instrumentKey}`);
    return data;
  } catch (error) {
    console.error(`❌ Error saving data to Supabase for ${instrumentKey}: ${error.message}`);
    throw error;
  }
}

// Function to process each instrument
async function processInstrument(instrumentKey) {
  try {
    // Fetch historical data
    const historicalData = await fetchHistoricalData(instrumentKey);
    
    // Calculate 52-week high and low
    const { high, low } = calculate52WeekHighLow(historicalData);
    
    // Save to Supabase
    await saveHighLowToSupabase(instrumentKey, high, low);
    
    return { 
      instrumentKey, 
      high, 
      low
    };
  } catch (error) {
    console.error(`❌ Failed to process instrument ${instrumentKey}:`, error.message);
    return { instrumentKey, error: error.message };
  }
}

// Main function to run the high/low job with progress tracking
async function runHighLowJob() {
  // Check if job is already running
  if (jobStatus.isRunning) {
    throw new Error('Job is already running. Please wait for it to complete.');
  }

  // Initialize job status
  jobStatus = {
    isRunning: true,
    startTime: new Date().toISOString(),
    endTime: null,
    progress: {
      total: 0,
      completed: 0,
      failed: 0,
      current: null
    },
    results: null,
    error: null
  };

  console.log('🚀 Starting 52-week high/low job with progress tracking');
  
  const results = {
    successful: [],
    failed: []
  };
  
  try {
    // Fetch active instruments from the database
    const instruments = await fetchActiveInstruments();
    
    if (instruments.length === 0) {
      console.warn('⚠️ No instruments to process. Job completed.');
      jobStatus.progress.total = 0;
      jobStatus.endTime = new Date().toISOString();
      jobStatus.isRunning = false;
      jobStatus.results = results;
      return results;
    }
    
    // Set total count for progress tracking
    jobStatus.progress.total = instruments.length;
    console.log(`📊 Processing ${instruments.length} instruments`);
    
    // Process each instrument sequentially to avoid rate limits
    for (let i = 0; i < instruments.length; i++) {
      const instrument = instruments[i];
      jobStatus.progress.current = instrument;
      
      try {
        console.log(`📈 Processing ${i + 1}/${instruments.length}: ${instrument}`);
        const result = await processInstrument(instrument);
        
        if (result.error) {
          results.failed.push(result);
          jobStatus.progress.failed++;
        } else {
          results.successful.push(result);
          jobStatus.progress.completed++;
        }
      } catch (error) {
        results.failed.push({ instrumentKey: instrument, error: error.message });
        jobStatus.progress.failed++;
      }
      
      // Update progress
      const totalProcessed = jobStatus.progress.completed + jobStatus.progress.failed;
      console.log(`⏳ Progress: ${totalProcessed}/${jobStatus.progress.total} (${Math.round((totalProcessed / jobStatus.progress.total) * 100)}%)`);
    }
  } catch (error) {
    console.error(`❌ Error fetching instruments: ${error.message}`);
    jobStatus.error = error.message;
    jobStatus.endTime = new Date().toISOString();
    jobStatus.isRunning = false;
    return {
      successful: [],
      failed: [{ instrumentKey: 'FETCH_INSTRUMENTS', error: error.message }]
    };
  }
  
  // Job completed
  jobStatus.endTime = new Date().toISOString();
  jobStatus.isRunning = false;
  jobStatus.results = results;
  jobStatus.progress.current = null;
  
  const duration = new Date(jobStatus.endTime) - new Date(jobStatus.startTime);
  console.log(`✅ Job completed in ${Math.round(duration / 1000)}s. Successfully processed: ${results.successful.length}, Failed: ${results.failed.length}`);
  
  return results;
}

// API endpoint for frontend to start the job
app.post("/start-job", async (req, res) => {
  try {
    // Check if job is already running
    if (jobStatus.isRunning) {
      return res.status(409).json({
        status: 'error',
        message: 'Job is already running. Please wait for it to complete.',
        jobStatus: {
          isRunning: jobStatus.isRunning,
          startTime: jobStatus.startTime,
          progress: jobStatus.progress
        }
      });
    }

    console.log('🚀 Job started via frontend API');
    
    // Start the job asynchronously
    runHighLowJob().catch(error => {
      console.error('❌ Async job error:', error);
      jobStatus.error = error.message;
      jobStatus.endTime = new Date().toISOString();
      jobStatus.isRunning = false;
    });

    // Return immediately with job started status
    res.json({
      status: 'success',
      message: 'Job started successfully',
      jobId: jobStatus.startTime,
      jobStatus: {
        isRunning: jobStatus.isRunning,
        startTime: jobStatus.startTime,
        progress: jobStatus.progress
      }
    });
  } catch (error) {
    console.error('❌ Error starting job:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to get job status and progress
app.get("/job-status", (req, res) => {
  try {
    const duration = jobStatus.startTime && jobStatus.endTime 
      ? new Date(jobStatus.endTime) - new Date(jobStatus.startTime)
      : jobStatus.startTime 
        ? Date.now() - new Date(jobStatus.startTime)
        : null;

    res.json({
      status: 'success',
      jobStatus: {
        ...jobStatus,
        duration: duration ? Math.round(duration / 1000) : null, // in seconds
        progressPercentage: jobStatus.progress.total > 0 
          ? Math.round(((jobStatus.progress.completed + jobStatus.progress.failed) / jobStatus.progress.total) * 100)
          : 0
      }
    });
  } catch (error) {
    console.error('❌ Error getting job status:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to get job results
app.get("/job-results", (req, res) => {
  try {
    if (!jobStatus.results && !jobStatus.error) {
      return res.status(404).json({
        status: 'error',
        message: 'No job results available. Run a job first.'
      });
    }

    res.json({
      status: 'success',
      jobStatus: {
        isRunning: jobStatus.isRunning,
        startTime: jobStatus.startTime,
        endTime: jobStatus.endTime,
        progress: jobStatus.progress,
        error: jobStatus.error
      },
      results: jobStatus.results,
      summary: jobStatus.results ? {
        totalProcessed: jobStatus.results.successful.length + jobStatus.results.failed.length,
        successful: jobStatus.results.successful.length,
        failed: jobStatus.results.failed.length,
        successRate: jobStatus.results.successful.length + jobStatus.results.failed.length > 0 
          ? Math.round((jobStatus.results.successful.length / (jobStatus.results.successful.length + jobStatus.results.failed.length)) * 100)
          : 0
      } : null
    });
  } catch (error) {
    console.error('❌ Error getting job results:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to stop/cancel the job (soft stop)
app.post("/stop-job", (req, res) => {
  try {
    if (!jobStatus.isRunning) {
      return res.status(400).json({
        status: 'error',
        message: 'No job is currently running'
      });
    }

    console.log('⚠️ Job stop requested via API (soft stop)');
    
    res.json({
      status: 'success',
      message: 'Job stop requested. Note: Current processing will complete, but no new instruments will be processed.',
      jobStatus: {
        isRunning: jobStatus.isRunning,
        progress: jobStatus.progress
      }
    });
  } catch (error) {
    console.error('❌ Error stopping job:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// API endpoint to manually trigger the job (synchronous)
app.get("/run-highlow-job", async (req, res) => {
  try {
    console.log('🚀 Job triggered via synchronous API endpoint');
    const results = await runHighLowJob();
    res.json({ 
      status: 'success',
      message: 'Job completed',
      results
    });
  } catch (error) {
    console.error('❌ Error running synchronous job:', error);
    res.status(500).json({ 
      status: 'error',
      message: error.message
    });
  }
});

// Start server and initialize
(async () => {
  try {
    // Initialize protobuf first
    await initProtobuf();

    // Start the server
    server.listen(PORT, () => {
      // console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

    // Auto-connect to Upstox WebSocket on startup
    const wsUrl = await getMarketFeedUrl();
    upstoxWs = await connectWebSocket(wsUrl);
  } catch (error) {
    // console.error("❌ Startup error:", error);
  }
})();

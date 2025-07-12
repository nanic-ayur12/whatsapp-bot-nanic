const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SHOP = process.env.SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
const INACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds

const sessions = {};

// Activity tracking
let lastActivity = Date.now();
let keepAliveInterval = null;

// Function to update last activity
const updateActivity = () => {
  lastActivity = Date.now();
};

// Function to send keep-alive request
const sendKeepAlive = async () => {
  try {
    const timeSinceLastActivity = Date.now() - lastActivity;
    console.log(`Checking activity: ${Math.round(timeSinceLastActivity / 1000)}s since last activity`);
    
    if (timeSinceLastActivity > INACTIVITY_THRESHOLD) {
      console.log('Sending keep-alive request to prevent spin-down');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(`${KEEP_ALIVE_URL}/api/health`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Keep-Alive-Bot',
          'X-Keep-Alive': 'true'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        console.log('Keep-alive request successful');
      } else {
        console.warn(`Keep-alive request failed with status: ${response.status}`);
      }
    } else {
      console.log('Recent activity detected, skipping keep-alive request');
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Keep-alive request timed out');
    } else {
      console.error('Keep-alive request failed:', error.message);
    }
  }
};

// Start keep-alive monitoring (enable if KEEP_ALIVE_URL is set)
if (process.env.KEEP_ALIVE_URL) {
  keepAliveInterval = setInterval(sendKeepAlive, KEEP_ALIVE_INTERVAL);
  console.log(`Keep-alive monitoring started (checking every ${KEEP_ALIVE_INTERVAL / 60000} minutes)`);
}

// Activity tracking middleware (must be before other middleware)
app.use((req, res, next) => {
  // Don't count keep-alive requests as activity
  if (req.get('X-Keep-Alive') !== 'true') {
    updateActivity();
  }
  next();
});

// Logging middleware
app.use((req, res, next) => {
  const isKeepAlive = req.get('X-Keep-Alive') === 'true';
  if (!isKeepAlive) {
    console.log(`${req.method} ${req.path} - ${req.ip}`);
  } else {
    console.log(`Keep-alive request: ${req.method} ${req.path}`);
  }
  next();
});

// Razorpay instance
const Razorpay = require("razorpay");
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const productDetails = {
  '41392567746606': { name: 'Kungiliyam Bath Soap', price: 80 },
  '41382358908974': { name: 'Kumkumadi Face Serum', price: 270 },
  '41386859364398': { name: 'Honey & Vanilla Lip Balm', price: 234 },
  '41386853990446': { name: 'Aloe Vera Hair Cleanser', price: 245 },
  '41392567255086': { name: 'Traditional Kajal', price: 225 },
  '41374936727598': { name: 'Traditional Kumkum', price: 199 },
  '41422183333934': { name: 'Bhringaraj Hair Cleanser', price: 216 }
};

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

async function sendWelcomeMessage(phone) {
  updateActivity(); // Update activity when sending messages
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: phone,
      text: {
        body: `🌿 *Welcome to Nanic Ayurveda's WhatsApp Shop!*\n\n🛍️ Just choose a product from our WhatsApp catalog to place your order.\n\nType:\n- *Catalog* to view products\n- *Track* to check your order status`
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      }
    }
  );
}

const sendMessage = async (phone, message) => {
  updateActivity(); // Update activity when sending messages
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: phone,
      text: { body: message }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
};

app.post('/webhook', async (req, res) => {
  updateActivity(); // Update activity on webhook calls
  
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const from = msg.from;
  const type = msg.type;
  const session = sessions[from] || { step: 'cart' };

  if (type === 'order') {
    if (session.step !== 'cart') {
      await sendMessage(from, '🛒 Your order is already being processed.');
      return res.sendStatus(200);
    }

    const products = msg.order?.product_items;
    if (!Array.isArray(products)) {
      await sendMessage(from, '❌ Invalid order format.');
      return res.sendStatus(200);
    }

    let total = 0;
    let summary = '🛒 Cart Summary:\n';
    session.cart = [];

    products.forEach(p => {
      const product = productDetails[p.product_retailer_id];
      if (!product) return;

      const price = p.item_price || product.price;
      const quantity = p.quantity || 1;
      const itemTotal = price * quantity;
      total += itemTotal;

      summary += `- ${product.name} x ${quantity} = ₹${itemTotal}\n`;
      session.cart.push({ name: product.name, quantity, price });
    });

    session.total = total;
    session.step = 'name';
    sessions[from] = session;

    await sendMessage(from, summary + '\n🧾 Please enter your *Name*');
    return res.sendStatus(200);
  }

  if (type === 'text') {
    const text = msg.text.body.trim();

    if (['hi', 'Hi'].includes(text.toLowerCase())) {
      await sendWelcomeMessage(from);
      sessions[from] = { step: 'cart' };  // reset session fully
      return res.sendStatus(200);
    }

    // Catalog command
    if (text.toLowerCase() === 'catalog') {
      // If user has an unfulfilled order
      if (session.lastOrder && session.lastOrder.status === 'Not fulfilled yet') {
        const orderMsg = `🧾 Your recent order is already being processed.\n\n*ORDER ID:* ${session.lastOrder.name}\n*ORDER DATE:* ${new Date(session.lastOrder.date).toLocaleDateString()}\n*STATUS:* ${session.lastOrder.status}\n\nIf you want to place another order, message *New*.`;
        await sendMessage(from, orderMsg);
      } else {
        await sendMessage(from, '🛍️ You can browse our catalogue here: https://wa.me/c/919682564373. To order, choose the product and quantity from catalog and click place order to proceed to payment.');
      }
      return res.sendStatus(200);
    }

    if (text.toLowerCase() === 'new') {
      sessions[from] = { step: 'cart' }; // reset session
      await sendMessage(from, '🛍️ You can browse our catalogue here: https://wa.me/c/919682564373. To order, choose the product and quantity from catalog and click place order to proceed to payment.');
      return res.sendStatus(200);
    }

    // Track command
    if (text.toLowerCase() === 'track') {
      session.step = 'track_order';
      await sendMessage(from, 'Please enter your *Order ID* to track your order.');
      sessions[from] = session;
      return res.sendStatus(200);
    }

    // Tracking order by ID
    if (session.step === 'track_order') {
      const orderId = text // Shopify order names are usually uppercase
      try {
        const shopifyRes = await axios.get(
          `https://${SHOP}.myshopify.com/admin/api/2024-04/orders.json?name=${orderId}&status=any`,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            },
          }
        );

        const orders = shopifyRes.data.orders;
        if (orders.length === 0) {
          await sendMessage(from, `❌ No order found with ID ${orderId}. Please check and try again. Message *Hi* to restart the bot.`);
        } else {
          const order = orders[0];
          const financialStatus = order.financial_status;
          const fulfillmentStatus = order.fulfillment_status || 'Not fulfilled yet';

          await sendMessage(
            from,
            `✅ Order ID: ${order.name}\nPayment Status: ${financialStatus}\nFulfillment Status: ${fulfillmentStatus} \n\n Message *Hi* to restart the bot.`
          );
        }
      } catch (err) {
        console.error('Shopify order lookup error:', err);
        await sendMessage(from, '❌ Failed to fetch order details. Please try again later.\n\n Message *Hi* to restart the bot.');
      }

      session.step = 'START';
      sessions[from] = session;
      return res.sendStatus(200);
    }

    switch (session.step) {
      case 'name':
        session.name = text;
        session.step = 'email';
        await sendMessage(from, '📧 Please enter your *Email ID*');
        break;

      case 'email':
        session.email = text;
        session.step = 'mobile';
        await sendMessage(from, '📱 Please enter your *Mobile Number*');
        break;

      case 'mobile':
        session.mobile = text;
        session.step = 'checking_address';
        sessions[from] = session;

        try {
          // Search customer by email
          const customerSearchRes = await axios.get(
            `https://${SHOP}.myshopify.com/admin/api/2024-04/customers/search.json?query=email:${session.email}`,
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              },
            }
          );

          const customers = customerSearchRes.data.customers;

          if (customers.length > 0) {
            const customer = customers[0];
            session.customerId = customer.id;

            // Get saved addresses
            const addressesRes = await axios.get(
              `https://${SHOP}.myshopify.com/admin/api/2024-04/customers/${customer.id}/addresses.json`,
              {
                headers: {
                  'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                },
              }
            );

            const addresses = addressesRes.data.addresses;

            if (addresses.length > 0) {
              const defaultAddr = customer.default_address || addresses[0];

              // Check for completeness
              if (!defaultAddr.address1 || !defaultAddr.city || !defaultAddr.zip) {
                session.step = 'address_line';
                await sendMessage(
                  from,
                  '🏠 Your saved address is incomplete. Please enter your *Address* ( Ex: No 1, Anna Street, Ganapathy Taluk )'
                );
              } else {
                session.foundAddress = {
                  name: defaultAddr.name || session.name || '',
                  line: defaultAddr.address1,
                  city: defaultAddr.city,
                  state: defaultAddr.province || '',
                  country: defaultAddr.country || 'India',
                  pincode: defaultAddr.zip,
                  phone: defaultAddr.phone || session.mobile || '',
                };

                session.step = 'reuse_address';

                const fullAddress = `${session.foundAddress.name}
                ${session.foundAddress.line},
                ${session.foundAddress.city}, ${session.foundAddress.state} - ${session.foundAddress.pincode}
                ${session.foundAddress.country}
                📞 ${session.foundAddress.phone}`.trim();

                await sendMessage(
                from,
                `📦 We found an existing address:\n${fullAddress}\n\nDo you want to use this address? Reply *Yes* or *No*.`
              );
            }
          } else {
            session.step = 'address_line';
            await sendMessage(from, '🏠 Please enter your *Address* ( Ex: No 1, Anna Street, Ganapathy Taluk )');
          }
        } else {
          session.step = 'address_line';
          await sendMessage(from, '🏠 Please enter your *Address* ( Ex: No 1, Anna Street, Ganapathy Taluk )');
        }
      } catch (err) {
        console.error('Shopify customer/address lookup error:', err?.response?.data || err.message);
        session.step = 'address_line';
        await sendMessage(from, '🏠 Please enter your *Address* ( Ex: No 1, Anna Street, Ganapathy Taluk )');
      }

      break;

      case 'reuse_address':
        if (text.toLowerCase() === 'yes') {
          session.address = { ...session.foundAddress };
          session.step = 'pincode_confirmed'; // skip to pincode confirmation logic
          // You could include the state logic here if needed
          const shipping = session.address.state.toLowerCase() === 'tn' ? 0 : 0;
          session.shipping = shipping;
          session.totalWithShipping = session.total + shipping;

          await sendMessage(from, `✅ Total: ₹${session.total}\n🚚 Shipping: ₹${shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nReply *YES* to continue to payment.`);
          session.step = 'confirm';
        } else if (text.toLowerCase() === 'no') {
          session.step = 'mobile';
          await sendMessage(from, '📱 Please enter your *Mobile Number*');
        } else {
          await sendMessage(from, '❓ Please reply with *Yes* or *No*.');
        }
        break;

      case 'address_line':
        session.address = { line: text };
        session.step = 'city';
        await sendMessage(from, '🏙️ Please enter your *City* (Ex: Chennai)');
        break;

      case 'city':
        session.address.city = text;
        session.step = 'state';
        await sendMessage(from, '🌆 Please enter your *State*. \n *NOTE:* If Tamil Nadu enter *TN* ');
        break;

      case 'state':
        session.address.state = text;
        session.step = 'pincode';
        await sendMessage(from, '📮 Please enter your *Pincode*');
        break;

      case 'pincode':
        session.address.pincode = text;
        const shipping = session.address.state.toLowerCase() === 'tn' ? 40 : 80;
        session.shipping = shipping;
        session.totalWithShipping = session.total + shipping;
        session.step = 'confirm';

        await sendMessage(from, `✅ Total: ₹${session.total}\n🚚 Shipping: ₹${shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nReply *YES* to continue to payment.`);
        break;

      case 'confirm':
        if (text.toLowerCase() === 'yes') {
          session.step = 'payment';
          try {
            const razorRes = await razorpay.paymentLink.create({
              amount: session.totalWithShipping * 100,
              currency: 'INR',
              description: `Order for ${session.name}`,
              customer: {
                name: session.name,
                email: session.email,
                contact: session.mobile,
              },
              notify: { sms: false, email: false },
              callback_url: "https://wpbot.nanic.in/razorpay-webhook",
              callback_method: "get"
            });

            session.paymentLinkId = razorRes.id;
            await sendMessage(from, `💳 Pay here:\n${razorRes.short_url}\n\nWe'll confirm your order once payment is completed.`);
          } catch (err) {
            console.error('Razorpay error:', err);
            await sendMessage(from, '❌ Failed to generate payment link.');
          }
        } else {
          await sendMessage(from, '❌ Cancelled. Type "Hi" to begin again.');
          delete sessions[from];
        }
        break;

      case 'payment':
        await sendMessage(from, '⏳ Awaiting payment confirmation...');
        break;

      case 'shopify':
        await sendMessage(from, '⏳ Order is already being processed.');
        break;

      default:
        await sendMessage(from, `❓ I didn't understand that. Please type:\n- *Catalog* to view products\n- *Track* to track your order`);
        break;
    }

    sessions[from] = session;
  }

  res.sendStatus(200);
});

// Enhanced health check with activity info
app.get('/api/health', (req, res) => {
  const isKeepAlive = req.get('X-Keep-Alive') === 'true';
  const timeSinceLastActivity = Date.now() - lastActivity;
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    lastActivity: new Date(lastActivity).toISOString(),
    timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000),
    isKeepAliveRequest: isKeepAlive
  });
});

// Activity status endpoint
app.get('/api/activity-status', (req, res) => {
  const timeSinceLastActivity = Date.now() - lastActivity;
  res.json({
    lastActivity: new Date(lastActivity).toISOString(),
    timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000),
    thresholdSeconds: INACTIVITY_THRESHOLD / 1000,
    isInactive: timeSinceLastActivity > INACTIVITY_THRESHOLD,
    keepAliveEnabled: !!(process.env.KEEP_ALIVE_URL)
  });
});

// ✅ Razorpay Webhook
app.post('/razorpay-webhook', express.json(), async (req, res) => {
  updateActivity(); // Update activity on webhook calls
  
  const event = req.body;

  if (event.event === 'payment_link.paid') {
    const linkId = event.payload.payment_link.entity.id;

    const phone = Object.keys(sessions).find(
      key => sessions[key]?.paymentLinkId === linkId
    );

    if (!phone) return res.sendStatus(404);
    const session = sessions[phone];

    try {
      const shippingAddress = {
        address1: session.address.line,
        city: session.address.city,
        province: "Tamil Nadu",
        zip: session.address.pincode,
        country: "India"
      };

      // 1. Search for existing customer by phone number
      const customerSearchRes = await axios.get(
        `https://${SHOP}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${phone}`,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          },
        }
      );

      let customerId;
      if (customerSearchRes.data.customers.length > 0) {
        customerId = customerSearchRes.data.customers[0].id;
      }

      // 2. Prepare order payload conditionally
      const orderPayload = {
        order: {
          // email: session.email,
          customer: {
        id: session.customerId // ✅ Use existing customer ID only
      },
          line_items: session.cart.map(item => ({
            title: item.name,
            quantity: item.quantity,
            price: item.price,
          })),
          financial_status: "paid",
          transactions: [
            {
              kind: "sale",
              status: "success",
              amount: session.totalWithShipping.toString(),
              gateway: "razorpay"
            }
          ],
          shipping_address: {
            address1: session.address.line,
            city: session.address.city,
            province: session.address.state,
            zip: session.address.pincode,
            country: "India",
            phone: `+91${session.mobile}`,
            name: session.name
          },
          billing_address: {
            address1: session.address.line,
            city: session.address.city,
            province: session.address.state,
            zip: session.address.pincode,
            country: "India",
            phone: `+91${session.mobile}`,
            name: session.name
          }
        }
      };

      if (customerId) {
        orderPayload.order.customer = { id: customerId };
      } else {
        orderPayload.order.customer = {
          first_name: session.name,
          email: session.email,
          phone: `+91${session.mobile}`,
        };
      }

      // 3. Create order
      const orderRes = await axios.post(
        `https://${SHOP}.myshopify.com/admin/api/2024-04/orders.json`,
        orderPayload,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      const order = orderRes.data.order;
      session.lastOrder = {
        name: order.name,
        date: order.created_at,
        status: order.fulfillment_status || 'Not fulfilled yet',
      };

      await sendMessage(phone, `✅ Order placed! 🧾\nOrder ID: *${order.name}*\nThank you for shopping with us! \n\nTo track your order send *Hi*`);

    } catch (err) {
      console.error('Shopify Error:', err?.response?.data || err.message || err);
      await sendMessage(phone, `❌ Failed to create your Shopify order.\nError: ${JSON.stringify(err?.response?.data || err.message)}`);
    }

    delete sessions[phone];
    return res.sendStatus(200);
  }

  res.sendStatus(400);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`✅ WhatsApp Bot running at http://localhost:${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Keep-alive monitoring: ${(process.env.KEEP_ALIVE_URL) ? 'ENABLED' : 'DISABLED'}`);
});

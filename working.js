const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");

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

// Flow IDs (you'll need to create these in your WhatsApp Business Manager)
const FLOW_IDS = {
  CHECKOUT: process.env.CHECKOUT_FLOW_ID, // Create this flow for checkout process
};

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

// Send Flow Message
const sendFlowMessage = async (phone, flowId, flowData = {}) => {
  updateActivity();
  
  const flowMessage = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: {
        type: 'text',
        text: '🛍️ Complete Your Order'
      },
      body: {
        text: 'Please fill out the form below to complete your order:'
      },
      footer: {
        text: 'Nanic Ayurveda'
      },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: crypto.randomBytes(16).toString('hex'),
          flow_id: flowId,
          flow_cta: 'Complete Order',
          flow_action: 'navigate',
          flow_action_payload: {
            screen: 'CHECKOUT',
            data: flowData
          }
        }
      }
    }
  };

  // Add debug logging to check what data is being sent
  console.log('Flow data being sent:', JSON.stringify(flowData, null, 2));
  console.log('Complete flow message:', JSON.stringify(flowMessage, null, 2));

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      flowMessage,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );
  } catch (error) {
    console.error('Flow message error:', error.response?.data || error.message);
  }
};

// Send interactive button message
const sendInteractiveMessage = async (phone, headerText, bodyText, buttons) => {
  updateActivity();
  
  const message = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: headerText
      },
      body: {
        text: bodyText
      },
      footer: {
        text: 'Nanic Ayurveda'
      },
      action: {
        buttons: buttons
      }
    }
  };

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      message,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );
  } catch (error) {
    console.error('Interactive message error:', error.response?.data || error.message);
  }
};

async function sendWelcomeMessage(phone) {
  updateActivity();
  
  const buttons = [
    {
      type: 'reply',
      reply: {
        id: 'catalog',
        title: '🛍️ View Catalog'
      }
    },
    {
      type: 'reply',
      reply: {
        id: 'track',
        title: '📦 Track Order'
      }
    }
  ];

  await sendInteractiveMessage(
    phone,
    '🌿 Welcome to Nanic Ayurveda!',
    'Welcome to our WhatsApp Shop! Choose an option below to get started.',
    buttons
  );
}

const sendMessage = async (phone, message) => {
  updateActivity();
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

// Handle Flow Response
const handleFlowResponse = async (flowResponse, phone) => {
  try {
    const { flow_token, response_json } = flowResponse;
    const data = JSON.parse(response_json);
    
    const session = sessions[phone] || {};
    
    // Update session with flow data
    session.name = data.name;
    session.email = data.email;
    session.mobile = data.mobile;
    session.address = {
      line: data.address,
      city: data.city,
      state: data.state,
      pincode: data.pincode
    };
    
    // Calculate shipping
    const shipping = session.address.state.toLowerCase() === 'tn' ? 40 : 80;
    session.shipping = shipping;
    session.totalWithShipping = session.total + shipping;
    
    sessions[phone] = session;
    
    // Send confirmation with payment
    const confirmButtons = [
      {
        type: 'reply',
        reply: {
          id: 'confirm_payment',
          title: '💳 Proceed to Payment'
        }
      },
      {
        type: 'reply',
        reply: {
          id: 'cancel_order',
          title: '❌ Cancel Order'
        }
      }
    ];
    
    await sendInteractiveMessage(
      phone,
      '✅ Order Summary',
      `Thank you ${session.name}!\n\n📦 Items Total: ₹${session.total}\n🚚 Shipping: ₹${shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nShipping to:\n${session.address.line}, ${session.address.city}, ${session.address.state} - ${session.address.pincode}`,
      confirmButtons
    );
    
  } catch (error) {
    console.error('Flow response handling error:', error);
    await sendMessage(phone, '❌ There was an error processing your order. Please try again.');
  }
};

app.post('/webhook', async (req, res) => {
  updateActivity();
  
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const from = msg.from;
  const type = msg.type;
  const session = sessions[from] || { step: 'start' };

  // Handle Flow responses
  if (type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
    await handleFlowResponse(msg.interactive.nfm_reply, from);
    return res.sendStatus(200);
  }

  // Handle interactive button responses
  if (type === 'interactive' && msg.interactive?.type === 'button_reply') {
    const buttonId = msg.interactive.button_reply.id;
    
    switch (buttonId) {
      case 'catalog':
        if (session.lastOrder && session.lastOrder.status === 'Not fulfilled yet') {
          const orderMsg = `🧾 Your recent order is already being processed.\n\n*ORDER ID:* ${session.lastOrder.name}\n*ORDER DATE:* ${new Date(session.lastOrder.date).toLocaleDateString()}\n*STATUS:* ${session.lastOrder.status}\n\nIf you want to place another order, message *New*.`;
          await sendMessage(from, orderMsg);
        } else {
          await sendMessage(from, '🛍️ You can browse our catalogue here: https://wa.me/c/919682564373. To order, choose the product and quantity from catalog and click place order to proceed to payment.');
        }
        break;
        
      case 'track':
        session.step = 'track_order';
        await sendMessage(from, 'Please enter your *Order ID* to track your order.');
        sessions[from] = session;
        break;
        
        case 'confirm_payment':
          session.step = 'payment';
          
          // Add validation before creating payment link
          if (!session.totalWithShipping || !session.name || !session.email || !session.mobile) {
            console.error('Missing required session data:', {
              totalWithShipping: session.totalWithShipping,
              name: session.name,
              email: session.email,
              mobile: session.mobile
            });
            await sendMessage(from, '❌ Missing order information. Please start over by typing "Hi".');
            break;
          }
        
          try {
            console.log('Creating Razorpay payment link with data:', {
              amount: session.totalWithShipping * 100,
              currency: 'INR',
              description: `Order for ${session.name}`,
              customer: {
                name: session.name,
                email: session.email,
                contact: session.mobile,
              }
            });
        
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
              callback_method: "get",
              options: {
                checkout: {
                  name: "Nanic Ayurveda",
                  description: "Ayurvedic Products",
                  prefill: {
                    name: session.name,
                    email: session.email,
                    contact: session.mobile
                  }
                }
              }
            });
        
            console.log('Razorpay payment link created successfully:', razorRes.id);
            session.paymentLinkId = razorRes.id;
            sessions[from] = session;
            
            await sendMessage(from, `💳 Complete your payment:\n${razorRes.short_url}\n\nWe'll confirm your order once payment is completed.`);
          } catch (err) {
            console.error('Razorpay error details:', {
              message: err.message,
              stack: err.stack,
              response: err.response?.data,
              statusCode: err.statusCode,
              error: err.error
            });
            await sendMessage(from, '❌ Failed to generate payment link. Please try again.');
          }
          break;
        
      case 'cancel_order':
        await sendMessage(from, '❌ Order cancelled. Type "Hi" to start over.');
        delete sessions[from];
        break;
    }
    
    return res.sendStatus(200);
  }

  if (type === 'order') {
    if (session.step === 'payment' || session.step === 'shopify') {
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
      session.cart.push({ name: product.name, quantity, price, variant_id: p.product_retailer_id });
    });

    session.total = total;
    session.step = 'checkout_flow';
    sessions[from] = session;

    // Send flow for checkout if flow ID is configured
    if (FLOW_IDS.CHECKOUT) {
      const flowData = {
        cart_summary: summary,
        total_amount: total.toString(), // Convert to string
        currency: 'INR'
      };
      
      await sendFlowMessage(from, FLOW_IDS.CHECKOUT, flowData);
    } else {
      // Fallback to traditional method
      await sendMessage(from, summary + '\n🧾 Please enter your *Name*');
      session.step = 'name';
    }
    
    return res.sendStatus(200);
  }

  if (type === 'text') {
    const text = msg.text.body.trim();

    if (['hi', 'hello', 'start'].includes(text.toLowerCase())) {
      await sendWelcomeMessage(from);
      sessions[from] = { step: 'start' };
      return res.sendStatus(200);
    }

    // Handle traditional text-based interactions (fallback)
    if (text.toLowerCase() === 'catalog') {
      if (session.lastOrder && session.lastOrder.status === 'Not fulfilled yet') {
        const orderMsg = `🧾 Your recent order is already being processed.\n\n*ORDER ID:* ${session.lastOrder.name}\n*ORDER DATE:* ${new Date(session.lastOrder.date).toLocaleDateString()}\n*STATUS:* ${session.lastOrder.status}\n\nIf you want to place another order, message *New*.`;
        await sendMessage(from, orderMsg);
      } else {
        await sendMessage(from, '🛍️ You can browse our catalogue here: https://wa.me/c/919682564373. To order, choose the product and quantity from catalog and click place order to proceed to payment.');
      }
      return res.sendStatus(200);
    }

    if (text.toLowerCase() === 'new') {
      sessions[from] = { step: 'start' };
      await sendMessage(from, '🛍️ You can browse our catalogue here: https://wa.me/c/919682564373. To order, choose the product and quantity from catalog and click place order to proceed to payment.');
      return res.sendStatus(200);
    }

    if (text.toLowerCase() === 'track') {
      session.step = 'track_order';
      await sendMessage(from, 'Please enter your *Order ID* to track your order.');
      sessions[from] = session;
      return res.sendStatus(200);
    }

    // Tracking order by ID
    if (session.step === 'track_order') {
      const orderId = text;
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
            `✅ Order ID: ${order.name}\nPayment Status: ${financialStatus}\nFulfillment Status: ${fulfillmentStatus}\n\nMessage *Hi* to restart the bot.`
          );
        }
      } catch (err) {
        console.error('Shopify order lookup error:', err);
        await sendMessage(from, '❌ Failed to fetch order details. Please try again later.\n\nMessage *Hi* to restart the bot.');
      }

      session.step = 'start';
      sessions[from] = session;
      return res.sendStatus(200);
    }

    // Handle traditional checkout flow (fallback when flows are not available)
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

              if (!defaultAddr.address1 || !defaultAddr.city || !defaultAddr.zip) {
                session.step = 'address_line';
                await sendMessage(
                  from,
                  '🏠 Your saved address is incomplete. Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)'
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

                const addressButtons = [
                  {
                    type: 'reply',
                    reply: {
                      id: 'use_address',
                      title: '✅ Use This Address'
                    }
                  },
                  {
                    type: 'reply',
                    reply: {
                      id: 'new_address',
                      title: '📝 Enter New Address'
                    }
                  }
                ];

                await sendInteractiveMessage(
                  from,
                  '📦 Existing Address Found',
                  `We found this address:\n${fullAddress}\n\nWould you like to use this address?`,
                  addressButtons
                );
              }
            } else {
              session.step = 'address_line';
              await sendMessage(from, '🏠 Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)');
            }
          } else {
            session.step = 'address_line';
            await sendMessage(from, '🏠 Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)');
          }
        } catch (err) {
          console.error('Shopify customer/address lookup error:', err?.response?.data || err.message);
          session.step = 'address_line';
          await sendMessage(from, '🏠 Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)');
        }
        break;

      case 'reuse_address':
        if (text.toLowerCase() === 'yes') {
          session.address = { ...session.foundAddress };
          session.step = 'pincode_confirmed';
          const shipping = session.address.state.toLowerCase() === 'tn' ? 40 : 80;
          session.shipping = shipping;
          session.totalWithShipping = session.total + shipping;

          const confirmButtons = [
            {
              type: 'reply',
              reply: {
                id: 'confirm_payment',
                title: '💳 Proceed to Payment'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'cancel_order',
                title: '❌ Cancel Order'
              }
            }
          ];

          await sendInteractiveMessage(
            phone,
            '✅ Order Summary',
            `Thank you ${session.name}!\n\n📦 Items Total: ₹${session.total}\n🚚 Shipping: ₹${shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nShipping to:\n${session.address.line}, ${session.address.city}, ${session.address.state} - ${session.address.pincode}`,
            confirmButtons
          );
        } else if (text.toLowerCase() === 'no') {
          session.step = 'address_line';
          await sendMessage(from, '🏠 Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)');
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
        await sendMessage(from, '🌆 Please enter your *State*.\n*NOTE:* If Tamil Nadu enter *TN*');
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

        const confirmButtons = [
          {
            type: 'reply',
            reply: {
              id: 'confirm_payment',
              title: '💳 Proceed to Payment'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'cancel_order',
              title: '❌ Cancel Order'
            }
          }
        ];

        await sendInteractiveMessage(
          from,
          '✅ Order Confirmation',
          `Total: ₹${session.total}\nShipping: ₹${shipping}\n*Grand Total: ₹${session.totalWithShipping}*`,
          confirmButtons
        );
        break;

      case 'payment':
        await sendMessage(from, '⏳ Awaiting payment confirmation...');
        break;

      case 'shopify':
        await sendMessage(from, '⏳ Order is already being processed.');
        break;

      default:
        await sendWelcomeMessage(from);
        break;
    }

    sessions[from] = session;
  }

  // Handle interactive button responses for address selection
  if (type === 'interactive' && msg.interactive?.type === 'button_reply') {
    const buttonId = msg.interactive.button_reply.id;
    
    if (buttonId === 'use_address') {
      session.address = { ...session.foundAddress };
      const shipping = session.address.state.toLowerCase() === 'tn' ? 40 : 80;
      session.shipping = shipping;
      session.totalWithShipping = session.total + shipping;

      // Debug session data before sending confirmation
      console.log('Session data after flow response:', {
        name: session.name,
        email: session.email,
        mobile: session.mobile,
        total: session.total,
        shipping: session.shipping,
        totalWithShipping: session.totalWithShipping
      });

      // Send confirmation with payment
      const confirmButtons = [
        {
          type: 'reply',
          reply: {
            id: 'confirm_payment',
            title: '💳 Proceed to Payment'
          }
        },
        {
          type: 'reply',
          reply: {
            id: 'cancel_order',
            title: '❌ Cancel Order'
          }
        }
      ];

      await sendInteractiveMessage(
        from,
        '✅ Order Confirmation',
        `Total: ₹${session.total}\nShipping: ₹${shipping}\n*Grand Total: ₹${session.totalWithShipping}*`,
        confirmButtons
      );
      
      sessions[from] = session;
    } else if (buttonId === 'new_address') {
      session.step = 'address_line';
      await sendMessage(from, '🏠 Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)');
      sessions[from] = session;
    }
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

// GET route for Razorpay webhook callback (to close the tab)
app.get('/razorpay-webhook', (req, res) => {
  console.log('GET /razorpay-webhook accessed with query params:', req.query);
  updateActivity();
  
  // Log all query parameters for debugging
  const queryParams = req.query;
  console.log('Query parameters received:', JSON.stringify(queryParams, null, 2));
  
  // Send HTML page that will close the tab
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
    <meta http-equiv="Pragma" content="no-cache">
    <meta http-equiv="Expires" content="0">
    <title>Payment Successful - Nanic Ayurveda</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        html, body {
            height: 100%;
            overflow: hidden;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            position: relative;
        }
        
        .container {
            text-align: center;
            background: rgba(255, 255, 255, 0.15);
            padding: 40px 30px;
            border-radius: 20px;
            backdrop-filter: blur(15px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
            max-width: 400px;
            width: 90%;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .success-icon {
            font-size: 60px;
            margin-bottom: 20px;
            animation: bounce 0.6s ease-in-out;
        }
        
        @keyframes bounce {
            0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
            40% { transform: translateY(-10px); }
            60% { transform: translateY(-5px); }
        }
        
        h1 {
            margin: 0 0 15px 0;
            font-size: 24px;
            font-weight: 600;
        }
        
        p {
            margin: 0 0 20px 0;
            opacity: 0.95;
            line-height: 1.6;
            font-size: 16px;
        }
        
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
            margin-right: 10px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .close-info {
            font-size: 14px;
            opacity: 0.8;
            margin-top: 15px;
        }
        
        .manual-close {
            margin-top: 20px;
            padding: 10px 20px;
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 10px;
            color: white;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .manual-close:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }
        
        /* Ensure the page is always visible */
        @media (max-width: 480px) {
            .container {
                padding: 30px 20px;
                margin: 20px;
            }
            
            h1 {
                font-size: 20px;
            }
            
            p {
                font-size: 14px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✅</div>
        <h1>Payment Successful!</h1>
        <p>Your order has been placed successfully. You will receive a confirmation message on WhatsApp shortly.</p>
        <p><span class="loading"></span>Closing this tab automatically...</p>
        <div class="close-info">If the tab doesn't close automatically, you can close it manually.</div>
        <button class="manual-close" onclick="closeTab()">Close Tab Now</button>
    </div>
    
    <script>
        // Function to close tab
        function closeTab() {
            try {
                window.close();
                console.log('Manual close attempted');
            } catch (e) {
                console.log('Manual close failed:', e);
                window.location.href = 'about:blank';
            }
        }
        
        // Ensure the page is fully loaded before attempting to close
        document.addEventListener('DOMContentLoaded', function() {
            console.log('Payment success page loaded');
            console.log('Current URL:', window.location.href);
            console.log('Query parameters:', window.location.search);
            
            // Force focus to ensure the page is visible
            window.focus();
            
            // Ensure the page is visible by scrolling to top
            window.scrollTo(0, 0);
            
            // Close the tab after 3 seconds
            setTimeout(() => {
                closeTab();
            }, 3000);
            
            // Also try to close on page visibility change (when user switches tabs)
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    setTimeout(() => {
                        closeTab();
                    }, 1000);
                }
            });
            
            // Additional fallback: try to close when user clicks anywhere on the page
            document.addEventListener('click', (e) => {
                // Don't trigger if clicking the manual close button
                if (!e.target.classList.contains('manual-close')) {
                    setTimeout(() => {
                        closeTab();
                    }, 500);
                }
            });
            
            // Try to close when page loses focus
            window.addEventListener('blur', () => {
                setTimeout(() => {
                    closeTab();
                }, 1000);
            });
        });
        
        // Handle any errors that might prevent the page from displaying
        window.addEventListener('error', function(e) {
            console.log('Page error detected:', e.error);
        });
        
        // Ensure the page loads even with query parameters
        if (window.location.search) {
            console.log('Query parameters detected:', window.location.search);
            // Force a repaint to ensure visibility
            setTimeout(() => {
                document.body.style.display = 'none';
                document.body.offsetHeight; // Force reflow
                document.body.style.display = 'flex';
            }, 100);
        }
    </script>
</body>
</html>`;

  res.send(html);
});

// Additional route to handle Razorpay redirects with different patterns
app.get('/payment-success', (req, res) => {
  console.log('GET /payment-success accessed with query params:', req.query);
  updateActivity();
  
  // Redirect to the main webhook route
  res.redirect('/razorpay-webhook' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''));
});

// Test route to verify webhook page is working
app.get('/test-payment-success', (req, res) => {
  console.log('GET /test-payment-success accessed');
  updateActivity();
  
  // Redirect to the main webhook route for testing
  res.redirect('/razorpay-webhook');
});

// Razorpay Webhook POST handler
app.post('/razorpay-webhook', express.json(), async (req, res) => {
  updateActivity();
  
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
        province: session.address.state,
        zip: session.address.pincode,
        country: "India"
      };

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

      const orderPayload = {
        order: {
          customer: {
            id: session.customerId
          },
          line_items: session.cart.map(item => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
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
          },
          shipping_lines: [
            {
              title: "Courier",
              price: session.shipping,
              code: "Courier"
            }
          ]
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

      await sendMessage(phone, `✅ Order placed! 🧾\nOrder ID: *${order.name}*\nThank you for shopping with us!\n\nTo track your order send *Hi*`);

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
  console.log(`🔄 WhatsApp Flows: ${(FLOW_IDS.CHECKOUT) ? 'ENABLED' : 'DISABLED (using fallback)'}`);
  console.log(`💳 Razorpay webhook URL: https://wpbot.nanic.in/razorpay-webhook`);
  console.log(`🔗 Payment success URL: https://wpbot.nanic.in/payment-success`);
});
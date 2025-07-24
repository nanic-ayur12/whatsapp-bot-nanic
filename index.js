const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection } = require('firebase/firestore');

require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

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

// Firebase helper functions
const getAddressFromFirebase = async (phoneNumber) => {
  try {
    const docRef = doc(db, 'addresses', phoneNumber);
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      return docSnap.data();
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error fetching address from Firebase:', error);
    return null;
  }
};

const saveAddressToFirebase = async (phoneNumber, addressData) => {
  try {
    const docRef = doc(db, 'addresses', phoneNumber);
    await setDoc(docRef, {
      ...addressData,
      lastUpdated: new Date().toISOString(),
      phoneNumber: phoneNumber
    }, { merge: true });
    console.log('Address saved to Firebase successfully');
    return true;
  } catch (error) {
    console.error('Error saving address to Firebase:', error);
    return false;
  }
};

const productDetails = {
  '41392567746606': { name: 'Kungiliyam Bath Soap', price: 80 },
  '41382358908974': { name: 'Kumkumadi Face Serum', price: 270 },
  '41386859364398': { name: 'Honey & Vanilla Lip Balm', price: 234 },
  '41386853990446': { name: 'Aloe Vera Hair Cleanser', price: 245 },
  '41392567255086': { name: 'Traditional Kajal', price: 225 },
  '41374936727598': { name: 'Traditional Kumkum', price: 199 },
  '41422183333934': { name: 'Bhringaraj Hair Cleanser', price: 216 },
  '41462328623150': { name: 'Test Product Not For Sale', price: 1 }
};

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// Send catalog message
const sendCatalogMessage = async (phone) => {
  updateActivity();
  
  const catalogMessage = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: {
        text: '🛍️ Browse our Ayurvedic products catalog below:'
      },
      footer: {
        text: 'Nanic Ayurveda'
      },
      action: {
        name: 'catalog_message',
        parameters: {
          thumbnail_product_retailer_id: '41392567746606' // Use first product as thumbnail
        }
      }
    }
  };

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      catalogMessage,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );
  } catch (error) {
    console.error('Catalog message error:', error.response?.data || error.message);
    // Fallback to text message with link if catalog fails
    await sendMessage(phone, '🛍️ You can browse our catalogue here: https://wa.me/c/919682564373. To order, choose the product and quantity from catalog and click place order to proceed to payment.');
  }
};

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

// Helper function to get customer addresses from Shopify
// SECTION 1: Enhanced logging in getCustomerAddresses function (around line 250-320)
// Replace the existing getCustomerAddresses function with this updated version:

async function getCustomerAddresses(phoneOrEmail, isEmail = false) {
  try {
    console.log(`Searching for customer with ${isEmail ? 'email' : 'phone'}: ${phoneOrEmail}`);
    let customers = [];
    if (isEmail) {
      // Search by email
      const searchQuery = `email:${phoneOrEmail}`;
      console.log('Email search query:', searchQuery);
      const customerSearchRes = await axios.get(
        `https://${SHOP}.myshopify.com/admin/api/2024-04/customers/search.json`,
        {
          headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
          params: { searchQuery }
        }
      );
      customers = customerSearchRes.data.customers;
    } else {
      // Search by phone - try multiple formats
      const cleanPhone = phoneOrEmail.replace(/\D/g, '');
      console.log('Clean phone number:', cleanPhone);
      const phoneFormats = [
        cleanPhone,
        `+91${cleanPhone}`,
        `91${cleanPhone}`,
        `+${cleanPhone}`
      ];
      for (const phoneFormat of phoneFormats) {
        console.log(`Trying phone format: ${phoneFormat}`);
        try {
          const customerSearchRes = await axios.get(
            `https://${SHOP}.myshopify.com/admin/api/2024-04/customers/search.json`,
            {
              headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
              params: { phoneFormat }
            }
          );
          customers = customerSearchRes.data.customers;
          console.log(`Found ${customers.length} customers with phone format: ${phoneFormat}`);
          if (customers.length > 0) {
            break;
          }
        } catch (err) {
          console.log(`Phone format ${phoneFormat} failed:`, err.message);
          continue;
        }
      }
    }
    
    console.log('Found customers:', customers.length);
    if (customers.length === 0) {
      return [];
    }
    
    const customer = customers[0];
    console.log('Customer data:', JSON.stringify(customer, null, 2));
    
    // Get customer addresses
    const addressesRes = await axios.get(
      `https://${SHOP}.myshopify.com/admin/api/2024-04/customers/${customer.id}/addresses.json`,
      {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
      }
    );
    const addresses = addressesRes.data.addresses;
    console.log('Raw customer addresses from API:', JSON.stringify(addresses, null, 2));
    
    let allAddresses = [];
    
    // Add default address first if it exists
    if (customer.default_address) {
      console.log('Default address found:', JSON.stringify(customer.default_address, null, 2));
      allAddresses.push({
        ...customer.default_address,
        isDefault: true,
        customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Customer',
        customer_email: customer.email || '',
        customer_phone: customer.phone || '',
        customerId: customer.id
      });
    }
    
    // Add other addresses
    addresses.forEach(addr => {
      console.log('Processing address:', JSON.stringify(addr, null, 2));
      const isDuplicate = allAddresses.some(existing => existing.id === addr.id);
      if (!isDuplicate) {
        allAddresses.push({
          ...addr,
          isDefault: false,
          customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Customer',
          customer_email: customer.email || '',
          customer_phone: customer.phone || '',
          customerId: customer.id
        });
      }
    });
    
    console.log('Final processed addresses:', JSON.stringify(allAddresses, null, 2));
    return allAddresses;
  } catch (error) {
    console.error('Error fetching customer addresses:', error.response?.data || error.message);
    return [];
  }
}

// SECTION 2: Fixed formatAddress function (around line 368)
// Replace the existing formatAddress function with this updated version:

function formatAddress(address, index) {
  console.log('Formatting address:', JSON.stringify(address, null, 2));
  
  // Handle name - try multiple fields
  const firstName = address.first_name || address.customer_name?.split(' ')[0] || '';
  const lastName = address.last_name || address.customer_name?.split(' ')[1] || '';
  const name = address.name || `${firstName} ${lastName}`.trim() || address.customer_name || 'Customer';
  
  // Handle company
  const company = address.company ? `\n🏢 ${address.company}` : '';
  
  // Handle address lines - be more flexible with field names
  const address1 = address.address1 || address.street || address.line1 || '';
  const address2 = address.address2 || address.line2 || '';
  const fullAddress = [address1, address2].filter(Boolean).join(', ') || 'Address not available';
  
  // Handle location details
  const city = address.city || address.locality || '';
  const province = address.province || address.province_code || address.state || address.region || '';
  const zip = address.zip || address.postal_code || address.pincode || '';
  const country = address.country || address.country_code || 'India';
  
  // Handle phone
  const phone = address.phone || address.customer_phone || '';
  
  // Default indicator
  const defaultText = address.isDefault ? ' ⭐ (Default)' : '';

  // Build the formatted address string
  let formattedAddress = `${index}. ${name}${defaultText}${company}`;
  
  if (fullAddress !== 'Address not available') {
    formattedAddress += `\n📍 ${fullAddress}`;
  } else {
    formattedAddress += `\n📍 Address not available`;
  }
  
  if (city || province || zip) {
    const locationParts = [city, province, zip].filter(Boolean);
    if (locationParts.length > 0) {
      formattedAddress += `\n🏙️ ${locationParts.join(', ')}`;
    }
  }
  
  if (country) {
    formattedAddress += `\n🌍 ${country}`;
  }
  
  if (phone) {
    formattedAddress += `\n📞 ${phone}`;
  }

  return formattedAddress;
}
// Helper: Validate discount code with Shopify
async function validateDiscountCode(code, total) {
  if (!code) return { valid: false };
  try {
    // Find price rules with this code
    const rulesRes = await axios.get(
      `https://${SHOP}.myshopify.com/admin/api/2024-04/discount_codes/lookup.json?code=${encodeURIComponent(code)}`,
      {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
      }
    );
    const discount = rulesRes.data.discount_code;
    if (!discount || !discount.price_rule_id) return { valid: false };

    // Get price rule details
    const ruleRes = await axios.get(
      `https://${SHOP}.myshopify.com/admin/api/2024-04/price_rules/${discount.price_rule_id}.json`,
      {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
      }
    );
    const rule = ruleRes.data.price_rule;
    if (!rule || !rule.value_type || !rule.value) return { valid: false };

    // Calculate discount
    let discountAmount = 0;
    if (rule.value_type === 'percentage') {
      discountAmount = Math.round((parseFloat(rule.value) * total) / 100);
    } else if (rule.value_type === 'fixed_amount') {
      discountAmount = Math.abs(parseFloat(rule.value));
    }
    // Clamp discount to total
    if (discountAmount > total) discountAmount = total;
    return { valid: true, amount: discountAmount, rule };
  } catch (err) {
    console.error('Discount code validation error:', err?.response?.data || err.message);
    return { valid: false };
  }
}

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
    session.delivery_type = data.delivery_type || 'ship';
    session.discount_code = data.discount_code || '';

    // Save address to Firebase
    const addressData = {
      name: session.name,
      email: session.email,
      mobile: session.mobile,
      address: session.address.line,
      city: session.address.city,
      state: session.address.state,
      pincode: session.address.pincode
    };
    
    const saveResult = await saveAddressToFirebase(session.mobile, addressData);
    
    // Add this confirmation message after saving
    if (saveResult) {
      await sendMessage(phone, '💾 This address has been saved to the system. From your next order select "Use Existing" and use this address.');
    }

    // Delivery type logic
    let shipping = 0;
    if (session.delivery_type === 'pickup') {
      shipping = 0;
    } else {
      shipping = session.address.state && session.address.state.toLowerCase() === 'tn' ? 40 : 80;
    }
    session.shipping = shipping;

    // Discount code logic
    let discountAmount = 0;
    let discountMsg = '';
    if (session.discount_code) {
      const discountRes = await validateDiscountCode(session.discount_code, session.total + shipping);
      if (discountRes.valid) {
        discountAmount = discountRes.amount;
        session.discount_value = discountAmount;
        discountMsg = `\n🎟️ Discount Applied: -₹${discountAmount} (${session.discount_code})`;
      } else {
        session.discount_value = 0;
        // Show retry/skip options
        const retryButtons = [
          { type: 'reply', reply: { id: 'retry_discount', title: '🔄 Try Another' } },
          { type: 'reply', reply: { id: 'skip_discount', title: '⏭️ Skip Discount' } }
        ];
        await sendInteractiveMessage(phone, '❌ Invalid Discount Code', 
          `Sorry, the discount code "${session.discount_code}" is invalid or expired.\n\nWould you like to try another discount code?`, 
          retryButtons);
        session.step = 'discount_retry';
        sessions[phone] = session;
        return;
      }
    } else {
      session.discount_value = 0;
    }

    session.totalWithShipping = session.total + shipping - discountAmount;
    if (session.totalWithShipping < 0) session.totalWithShipping = 0;
    sessions[phone] = session;

    // Send confirmation with payment
    const confirmButtons = [
      {
        type: 'reply',
        reply: {
          id: 'confirm_payment',
          title: '💳 Proceed Payment'
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
      `Thank you ${session.name}!\n\n📦 Items Total: ₹${session.total}${discountMsg}\n🚚 Shipping: ₹${shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nShipping to:\n${session.address.line}, ${session.address.city}, ${session.address.state} - ${session.address.pincode}\nDelivery Method: ${session.delivery_type === 'pickup' ? '🏪 Pickup from Store' : '🚚 Ship to Address'}`,
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
          // Send catalog message instead of text with link
          await sendCatalogMessage(from);
        }
        break;
        
      case 'track':
        session.step = 'track_order';
        await sendMessage(from, 'Please enter your *Order ID* to track your order.');
        sessions[from] = session;
        break;

      case 'yes_discount':
        session.step = 'enter_discount_code';
        await sendMessage(from, 'Please enter your *Discount Code*:');
        sessions[from] = session;
        break;

      case 'no_discount':
        session.discount_code = '';
        await generateOrderSummary(from, session);
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

      case 'retry_discount':
        session.step = 'discount_input';
        await sendMessage(from, '🎟️ Please enter your discount code:');
        sessions[from] = session;
        break;
        // If this session was created by a Flow, re-trigger the Flow UI
        // if (session.cart && session.total) {
        //   // Re-send the Flow for discount code entry
        //   const flowData = {
        //     cart_summary: session.cart_summary || '', // or reconstruct from session.cart
        //     total_amount: session.total.toString(),
        //     currency: session.currency || 'INR',
        //     name: session.name,
        //     email: session.email,
        //     mobile: session.mobile,
        //     address: session.address?.line,
        //     city: session.address?.city,
        //     state: session.address?.state,
        //     pincode: session.address?.pincode,
        //     delivery_type: session.delivery_type,
        //   };
        //   await sendFlowMessage(from, FLOW_IDS.CHECKOUT, flowData);
        // } else {
        //   // Fallback to text-based
        //   session.step = 'discount_input';
        //   await sendMessage(from, '🎟️ Please enter your discount code:');
        //   sessions[from] = session;
        // }
        break;

      case 'apply_discount':
        session.step = 'enter_discount_saved';
        await sendMessage(from, '🎟️ Please enter your discount code:');
        sessions[from] = session;
        break;

      case 'skip_discount_saved':
        session.discount_code = '';
        session.discount_value = 0;
        session.step = 'delivery_method_saved';
        const deliveryButtons = [
          {
            type: 'reply',
            reply: {
              id: 'ship_to_addr',
              title: '🚚 Ship to Address'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'pickup_store',
              title: '🏪 Store Pickup'
            }
          }
        ];

        await sendInteractiveMessage(
          from,
          '🚚 Delivery Method',
          'Please choose your preferred delivery method:',
          deliveryButtons
        );
        sessions[from] = session;
        break;

      case 'skip_discount':
        // Skip discount and proceed to payment
        session.discount_code = '';
        session.discount_value = 0;
        session.totalWithShipping = session.total + session.shipping;
        sessions[from] = session;

        const confirmButtonsSkip = [
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
          '✅ Order Summary',
          `Thank you ${session.name}!\n\n📦 Items Total: ₹${session.total}\n🚚 Shipping: ₹${session.shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nShipping to:\n${session.address.line}, ${session.address.city}, ${session.address.state} - ${session.address.pincode}\nDelivery Method: ${session.delivery_type === 'pickup' ? '🏪 Pickup from Store' : '🚚 Ship to Address'}`,
          confirmButtonsSkip
        );
        break;
      
      // case 'use_existing':
      //   session.step = 'enter_phone_for_address';
      //   await sendMessage(from, '📱 Please enter your 10-digit mobile number to fetch your saved address:');
      //   sessions[from] = session;
      //   break;

      case 'use_existing':
        // Use the WhatsApp number directly instead of asking for it
        const phoneNumber = from.replace(/\D/g, ''); // Remove non-digits from WhatsApp number
        
        // Check Firebase for existing address using the WhatsApp number
        const savedAddress = await getAddressFromFirebase(phoneNumber);
        
        if (savedAddress) {
          session.savedAddress = savedAddress;
          session.name = savedAddress.name;
          session.email = savedAddress.email;
          session.mobile = savedAddress.mobile;
          session.address = {
            line: savedAddress.address,
            city: savedAddress.city,
            state: savedAddress.state,
            pincode: savedAddress.pincode
          };
          
          const addressText = `📍 Saved Address Found:\n\n👤 ${savedAddress.name}\n📧 ${savedAddress.email}\n📱 ${savedAddress.mobile}\n🏠 ${savedAddress.address}\n🏙️ ${savedAddress.city}, ${savedAddress.state} - ${savedAddress.pincode}`;
          
          const addressChoiceButtons = [
            {
              type: 'reply',
              reply: {
                id: 'use_saved_addr',
                title: '✅ Use This'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'use_new_addr',
                title: '🆕 Use New'
              }
            }
          ];

          await sendInteractiveMessage(
            from,
            'Address Found!',
            addressText + '\n\nWould you like to use this address?',
            addressChoiceButtons
          );
          
          session.step = 'address_choice';
        } else {
          await sendMessage(from, '❌ No saved address found for your number.');
          
          // Send flow for new address entry
          if (FLOW_IDS.CHECKOUT) {
            const flowData = {
              cart_summary: session.cart_summary,
              total_amount: session.total.toString(),
              currency: 'INR'
            };
            
            await sendFlowMessage(from, FLOW_IDS.CHECKOUT, flowData);
            session.step = 'checkout_flow';
          } else {
            // Fallback to traditional method
            await sendMessage(from, session.cart_summary + '\n🧾 Please enter your *Name*');
            session.step = 'name';
          }
        }
        
        sessions[from] = session;
        break;

      case 'enter_new':
        // Send flow for new address entry
        if (FLOW_IDS.CHECKOUT) {
          const flowData = {
            cart_summary: session.cart_summary,
            total_amount: session.total.toString(),
            currency: 'INR'
          };
          
          await sendFlowMessage(from, FLOW_IDS.CHECKOUT, flowData);
          session.step = 'checkout_flow';
          sessions[from] = session;
        } else {
          // Fallback to traditional method
          await sendMessage(from, session.cart_summary + '\n🧾 Please enter your *Name*');
          session.step = 'name';
          sessions[from] = session;
        }
        break;

      case 'use_saved_addr':
        session.step = 'discount_offer';
        const discountButtons = [
          {
            type: 'reply',
            reply: {
              id: 'apply_discount',
              title: '🎟️ Apply Discount'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'skip_discount_saved',
              title: '⏭️ Skip Discount'
            }
          }
        ];

        await sendInteractiveMessage(
          from,
          '🎟️ Discount Code',
          'Would you like to apply a discount code to your order?',
          discountButtons
        );
        sessions[from] = session;
        break;

      case 'use_new_addr':
        // Send flow for new address entry
        if (FLOW_IDS.CHECKOUT) {
          const flowData = {
            cart_summary: session.cart_summary,
            total_amount: session.total.toString(),
            currency: 'INR'
          };
          
          await sendFlowMessage(from, FLOW_IDS.CHECKOUT, flowData);
          session.step = 'checkout_flow';
          sessions[from] = session;
        } else {
          // Fallback to traditional method
          await sendMessage(from, session.cart_summary + '\n🧾 Please enter your *Name*');
          session.step = 'name';
          sessions[from] = session;
        }
        break;

      case 'ship_to_addr':
        session.delivery_type = 'ship';
        session.shipping = session.savedAddress.state && session.savedAddress.state.toLowerCase() === 'tn' ? 40 : 80;
        await generateOrderSummary(from, session);
        break;

      case 'pickup_store':
        session.delivery_type = 'pickup';
        session.shipping = 0;
        await generateOrderSummary(from, session);
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
    let summary = 'Cart Summary:\n';
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
    session.cart_summary = summary;
    session.step = 'address_selection';
    sessions[from] = session;

    // Send address selection buttons
    const addressButtons = [
      {
        type: 'reply',
        reply: {
          id: 'use_existing',
          title: '📍 Use Existing'
        }
      },
      {
        type: 'reply',
        reply: {
          id: 'enter_new',
          title: '🆕 Enter New'
        }
      }
    ];

    await sendInteractiveMessage(
      from,
      '🛒 Cart Ready!',
      `${summary}\n💰 Total: ₹${total}\n\nChoose your address option:`,
      addressButtons
    );
    
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
        await sendCatalogMessage(from);
      }
      return res.sendStatus(200);
    }

    if (text.toLowerCase() === 'new') {
      sessions[from] = { step: 'start' };
      await sendCatalogMessage(from);
      return res.sendStatus(200);
    }

    if (text.toLowerCase() === 'track') {
      session.step = 'track_order';
      await sendMessage(from, 'Please enter your *Order ID* to track your order.');
      sessions[from] = session;
      return res.sendStatus(200);
    }

    // Handle discount code entry
    if (session.step === 'enter_discount_code') {
      session.discount_code = text.trim();
      await generateOrderSummary(from, session);
      return res.sendStatus(200);
    }

    // Handle phone number input for address lookup
    if (session.step === 'enter_phone_for_address') {
      const phoneNumber = text.trim().replace(/\D/g, ''); // Remove non-digits
      
      if (phoneNumber.length !== 10) {
        await sendMessage(from, '❌ Please enter a valid 10-digit mobile number:');
        return res.sendStatus(200);
      }

      // Check Firebase for existing address
      const savedAddress = await getAddressFromFirebase(phoneNumber);
      
      if (savedAddress) {
        session.savedAddress = savedAddress;
        session.name = savedAddress.name;
        session.email = savedAddress.email;
        session.mobile = savedAddress.mobile;
        session.address = {
          line: savedAddress.address,
          city: savedAddress.city,
          state: savedAddress.state,
          pincode: savedAddress.pincode
        };
        
        const addressText = `📍 Saved Address Found:\n\n👤 ${savedAddress.name}\n📧 ${savedAddress.email}\n📱 ${savedAddress.mobile}\n🏠 ${savedAddress.address}\n🏙️ ${savedAddress.city}, ${savedAddress.state} - ${savedAddress.pincode}`;
        
        const addressChoiceButtons = [
          {
            type: 'reply',
            reply: {
              id: 'use_saved_addr',
              title: '✅ Use This'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'use_new_addr',
              title: '🆕 Use New'
            }
          }
        ];

        await sendInteractiveMessage(
          from,
          'Address Found!',
          addressText + '\n\nWould you like to use this address?',
          addressChoiceButtons
        );
        
        session.step = 'address_choice';
      } else {
        await sendMessage(from, '❌ No saved address found for this number.');
        
        // Send flow for new address entry
        if (FLOW_IDS.CHECKOUT) {
          const flowData = {
            cart_summary: session.cart_summary,
            total_amount: session.total.toString(),
            currency: 'INR'
          };
          
          await sendFlowMessage(from, FLOW_IDS.CHECKOUT, flowData);
          session.step = 'checkout_flow';
        } else {
          // Fallback to traditional method
          await sendMessage(from, session.cart_summary + '\n🧾 Please enter your *Name*');
          session.step = 'name';
        }
      }
      
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
        session.step = 'address_line';
        await sendMessage(from, '🏠 Please enter your *Address* (Ex: No 1, Anna Street, Ganapathy Taluk)');
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
        await generateOrderSummary(from, session);
        break;

      case 'payment':
        await sendMessage(from, '⏳ Awaiting payment confirmation...');
        break;

      case 'discount_input':
        const discountCode = text.trim();
        if (discountCode) {
          const discountRes = await validateDiscountCode(discountCode, session.total);
          if (discountRes.valid) {
            session.discount_code = discountCode;
            session.discount_value = discountRes.amount;
            session.totalWithShipping = session.total + session.shipping - discountRes.amount;
            if (session.totalWithShipping < 0) session.totalWithShipping = 0;
            sessions[from] = session;

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
              '✅ Discount Applied Successfully!',
              `🎉 Great! Your discount code "${discountCode}" has been applied!\n\nOrder Summary:\n📦 Items Total: ₹${session.total}\n🎟️ Discount Applied: -₹${discountRes.amount} (${discountCode})\n🚚 Shipping: ₹${session.shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nShipping to:\n${session.address.line}, ${session.address.city}, ${session.address.state} - ${session.address.pincode}\nDelivery Method: ${session.delivery_type === 'pickup' ? '🏪 Pickup from Store' : '🚚 Ship to Address'}`,
              confirmButtons
            );
          } else {
            const retryButtons = [
              {
                type: 'reply',
                reply: {
                  id: 'retry_discount',
                   title: '🔄 Try Another Code'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'skip_discount',
                   title: '⏭️ Skip Discount'
                }
              }
            ];

            await sendInteractiveMessage(
              from,
              '❌ Invalid Discount Code',
              `Sorry, the discount code "${discountCode}" is invalid or expired.\n\nWould you like to try another discount code?`,
              retryButtons
            );
            session.step = 'discount_retry';
            sessions[from] = session;
          }
        } else {
          await sendMessage(from, '❓ Please enter a valid discount code or type "skip" to continue without discount.');
        }
        break;

      case 'discount_retry':
        // This case is handled by button responses above
        break;

      case 'enter_discount_saved':
        const userDiscountCode = text.trim();
        if (userDiscountCode) {
          const discountRes = await validateDiscountCode(userDiscountCode, session.total);
          if (discountRes.valid) {
            session.discount_code = userDiscountCode;
            session.discount_value = discountRes.amount;
            
            await sendMessage(from, `✅ Discount code "${userDiscountCode}" applied successfully! You'll save ₹${discountRes.amount}`);
            
            session.step = 'delivery_method_saved';
            const deliveryButtons = [
              {
                type: 'reply',
                reply: {
                  id: 'ship_to_addr',
                  title: '🚚 Ship to Address'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'pickup_store',
                  title: '🏪 Store Pickup'
                }
              }
            ];
            await sendInteractiveMessage(
              from,
              '🚚 Delivery Method',
              'Please choose your preferred delivery method:',
              deliveryButtons
            );
          } else {
            const retryButtons = [
              {
                type: 'reply',
                reply: {
                  id: 'apply_discount',
                  title: '🔄 Try Another'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'skip_discount_saved',
                  title: '⏭️ Skip Discount'
                }
              }
            ];
            await sendInteractiveMessage(
              from,
              '❌ Invalid Discount Code',
              `Sorry, the discount code "${userDiscountCode}" is invalid or expired.\n\nWould you like to try another code?`,
              retryButtons
            );
            session.step = 'discount_retry_saved';
          }
        } else {
          await sendMessage(from, '❓ Please enter a valid discount code:');
        }
        sessions[from] = session;
        break;
      case 'discount_retry_saved':
        // This will be handled by the button responses above
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

  res.sendStatus(200);
});

// Helper function to generate order summary
async function generateOrderSummary(phone, session) {
  // Set up address based on delivery type and selected address
  if (session.selectedAddress) {
    session.address = {
      line: session.selectedAddress.address1,
      city: session.selectedAddress.city,
      state: session.selectedAddress.province,
      pincode: session.selectedAddress.zip,
      country: session.selectedAddress.country || 'India'
    };
  }
  if (session.delivery_type === 'pickup') {
    // For pickup, DO NOT overwrite address, just set shipping to 0
    session.shipping = 0;
  } else {
    session.shipping = session.address.state && session.address.state.toLowerCase() === 'tn' ? 40 : 80;
  }

  // Handle discount code
  let discountAmount = 0;
  let discountMsg = '';
  if (session.discount_code) {
    const discountRes = await validateDiscountCode(session.discount_code, session.total);
    if (discountRes.valid) {
      discountAmount = discountRes.amount;
      session.discount_value = discountAmount;
      discountMsg = `\n🎟️ Discount Applied: -₹${discountAmount} (${session.discount_code})`;
    } else {
      session.discount_value = 0;
      discountMsg = `\n❌ Discount code invalid or expired.`;
    }
  } else {
    session.discount_value = 0;
  }

  session.totalWithShipping = session.total + session.shipping - discountAmount;
  if (session.totalWithShipping < 0) session.totalWithShipping = 0;
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
    `Thank you ${session.name}!\n\n📦 Items Total: ₹${session.total}${discountMsg}\n🚚 Shipping: ₹${session.shipping}\n💰 *Grand Total: ₹${session.totalWithShipping}*\n\nShipping to:\n${session.address.line}, ${session.address.city}, ${session.address.state} - ${session.address.pincode}\nDelivery Method: ${session.delivery_type === 'pickup' ? '🏪 Pickup from Store' : '🚚 Ship to Address'}`,
    confirmButtons
  );
}

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
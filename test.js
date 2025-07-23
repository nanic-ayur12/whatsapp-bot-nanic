require('dotenv').config();
const axios = require('axios');

const STORE = 'nanicayurveda.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const input = {
  phone: '+918668113739',
  email: '' // optional
};

async function fetchCustomerGraphQL({ email, phone }) {
  const queryStr = email ? `email:${email}` : phone ? `phone:${phone}` : null;

  if (!queryStr) {
    console.log('❌ Provide either email or phone.');
    return;
  }

  const query = `
  query {
    customers(first: 5, query: "${queryStr}") {
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          defaultAddress {
            name
            address1
            city
            province
            country
            zip
            phone
          }
          addresses(first: 10) {
            name
            address1
            city
            province
            country
            zip
            phone
          }
        }
      }
    }
  }
`;


  try {
    const res = await axios.post(
      `https://x0un1m-ix.myshopify.com/admin/api/2025-07/graphql.json`,
      { query },
      {
        headers: {
          'X-Shopify-Access-Token': TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(JSON.stringify(res.data, null, 2)); // ⬅️ Add this
const customers = res.data?.data?.customers?.edges || [];

    if (customers.length === 0) {
      console.log('❗ No customer found.');
      return;
    }

    for (const { node: customer } of customers) {
      console.log(`\n✅ ${customer.firstName} ${customer.lastName}`);
      console.log(`   Email: ${customer.email || 'N/A'}`);
      console.log(`   Phone: ${customer.phone || 'N/A'}`);

      const da = customer.defaultAddress;
      if (da) {
        console.log(`\n   📍 Default Address:`);
        console.log(`     ${da.name || ''}`);
        console.log(`     ${da.address1}, ${da.city}, ${da.province}, ${da.country}`);
        console.log(`     Phone: ${da.phone || 'N/A'} | Zip: ${da.zip || 'N/A'}`);
      }

      const addresses = customer.addresses;
      if (addresses.length) {
        console.log('\n   📍 Other Addresses:');
        addresses.forEach(({ node: addr }, i) => {
          console.log(`   ➤ Address ${i + 1}:`);
          console.log(`     ${addr.name || ''}`);
          console.log(`     ${addr.address1}, ${addr.city}, ${addr.province}, ${addr.country}`);
          console.log(`     Phone: ${addr.phone || 'N/A'} | Zip: ${addr.zip || 'N/A'}`);
        });
      }
    }
  } catch (err) {
    console.error('\n🔥 Error:', err.response?.data?.errors || err.message);
  }
}

fetchCustomerGraphQL(input);

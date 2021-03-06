// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * This sample demonstrates how to recognize US sales receipts from a file.
 */

const { FormRecognizerClient, AzureKeyCredential } = require("@azure/ai-form-recognizer");
const fs = require("fs");

// Load the .env file if it exists
require("dotenv").config();

async function main() {
  // You will need to set these environment variables or edit the following values
  const endpoint = process.env["FORM_RECOGNIZER_ENDPOINT"] || "<cognitive services endpoint>";
  const apiKey = process.env["FORM_RECOGNIZER_API_KEY"] || "<api key>";
  const path = "./assets/contoso-allinone.jpg";

  if (!fs.existsSync(path)) {
    throw new Error(`Expecting file ${path} exists`);
  }

  const readStream = fs.createReadStream(path);

  const client = new FormRecognizerClient(endpoint, new AzureKeyCredential(apiKey));
  const poller = await client.beginRecognizeReceipts(readStream, "image/jpeg", {
    onProgress: (state) => {
      console.log(`status: ${state.status}`);
    }
  });

  await poller.pollUntilDone();
  const receipts = poller.getResult();

  if (!receipts || receipts.length <= 0) {
    throw new Error("Expecting at lease one receipt in analysis result");
  }

  const usReceipt = receipts[0];
  console.log("First receipt:");
  console.log(`Receipt type: ${usReceipt.receiptType.type} with confidence ${usReceipt.receiptType.confidence}`);
  console.log(
    `Merchant Name: ${usReceipt.merchantName.value} (confidence: ${usReceipt.merchantName.confidence})`
  );
  console.log(
    `Transaction Date: ${usReceipt.transactionDate.value} (confidence: ${usReceipt.transactionDate.confidence})`
  );
  console.log("Receipt items:");
  console.log(`  name\tprice\tquantity\ttotalPrice`);
  for (const item of usReceipt.items) {
    const name = `${optionalToString(item.name.value)} (confidence: ${optionalToString(
      item.name.confidence
    )})`;
    const price = `${optionalToString(item.price.value)} (confidence: ${optionalToString(
      item.price.confidence
    )})`;
    const quantity = `${optionalToString(item.quantity.value)} (confidence: ${optionalToString(
      item.quantity.confidence
    )})`;
    const totalPrice = `${optionalToString(item.totalPrice.value)} (confidence: ${optionalToString(
      item.totalPrice.confidence
    )})`;
    console.log(`  ${name}\t${price}\t${quantity}\t${totalPrice}`);
  }

  // raw fields are also included in the result
  console.log("Raw 'MerchantAddress' field:");
  console.log(usReceipt.recognizedForm.fields["MerchantAddress"]);
}

function optionalToString(value) {
  return `${value || "<missing>"}`;
}

main().catch((err) => {
  console.error("The sample encountered an error:", err);
});

const pdfParse = require('pdf-parse');
const docxParser = require('docx-parser');
const fs = require('fs');
const path = require('path');
const nlp = require('compromise');
const { iso31661 } = require('iso-31661');
const languages = require('languages.json')

// Regular expressions for email, phone number, and LinkedIn URL
const emailRegex = /[a-zA-Z._%+-][a-zA-Z0-9._%+-]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const phoneRegex = /\+?\d{1,3}[0-9\-\(\) ]{10,20}/;
const linkedInRegex = /((https?:\/\/)?(www\.)?)?linkedin\.com\/(in\/)?[A-z0-9_-]+/gi;
const whatsAppRegex = /(https?:\/\/)?(wa\.me|api\.whatsapp\.com)\/[^\s]+/gi;
const telegramUrlRegex = /(https?:\/\/)?(t\.me|telegram\.me)\/[^\s]+/gi;
const telegramHandleRegex = /(?<![\w.])@\w+(?!\.\w)/gi;
const salaryRegex = /(?<currencySymbol>[\$€£])\s?(?<amount>\d+(?:,?\d{3})*(?:\.\d{1,2})?)( {1,3})(?<currencySymbol2>[\$€£])?\s?\s?(?:per year|annually|per annum|per month)?/gi;

// Lambda handler function
exports.handler = async (event) => {
    console.log(event)
    const { uploadCv: { body, format } } = event

    const fileContent = Buffer.from(body, 'base64'); // Expect the file as a base64 encoded string in the event

    let fileType = format ?? event.headers['Content-Type'];

    let extractedText = "";
    let extractedInfo = {};

    try {
        if (fileType === 'application/pdf') {
            extractedText = await extractFromPDF(fileContent);
        } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            extractedText = await extractFromDocx(fileContent);
        } else {
            return {
                statusCode: 400,
                message: 'Unsupported file type'
            };
        }

        const [firstName, lastName] = extractFullName(extractedText);
        extractedInfo = {
            firstName,
            lastName,
            fullName: firstName && lastName ? `${firstName} ${lastName}` : null,
            email: extractEmail(extractedText),
            phoneNumber: extractPhoneNumber(extractedText),
            linkedIn: extractLinkedIn(extractedText),
            country: extractCountry(extractedText),
            languages: extractLanguages(extractedText),
            whatsApp: extractWhatsApp(extractedText),
            telegram: extractTelegram(extractedText),
            desiredSalary: extractSalary(extractedText),
        };

        return {
            statusCode: 200,
            data: extractedInfo
        };
    } catch (error) {
        console.error("Error parsing resume:", error);
        return {
            statusCode: 500,
            message: 'Error parsing resume',
            error: error.message
        };
    }
};

// Helper function to extract text from PDF files
const extractFromPDF = async (fileContent) => {
    try {
        const data = await pdfParse(fileContent);
        return data.text; // Returns the extracted text from PDF
    } catch (error) {
        throw new Error(`Failed to parse PDF: ${error.message}`);
    }
}

// Helper function to extract text from DOCX files
const extractFromDocx = async (fileContent) => {
    return new Promise((resolve, reject) => {
        // Write the DOCX file temporarily
        const tempFilePath = path.join('/tmp', 'resume.docx');
        fs.writeFileSync(tempFilePath, fileContent);

        // Parse the DOCX file using docx-parser
        docxParser.parseDocx(tempFilePath, (error, data) => {
            if (error) {
                return reject(new Error(`Failed to parse DOCX: ${error.message}`));
            }

            // Delete the temporary file after parsing
            fs.unlinkSync(tempFilePath);
            resolve(data); // Return the extracted text
        });
    });
}

// Extract the full name using NLP (compromise)
const extractFullName = (text) => {
    const doc = nlp(text);
    const people = doc.people().out('array'); // Extracts names from the text
    const fullName = people?.[0];
    let [firstName, lastName] = fullName.split(' ');
    if (!lastName && people?.[1]?.split(' ')?.length == 1) lastName = people?.[1];
    return [firstName, lastName];
}

// Extract email using regex
const extractEmail = (text) => {
    const emailMatch = text.match(emailRegex);
    return emailMatch ? emailMatch[0] : null;
}

// Extract phone number using regex
const extractPhoneNumber = (text) => {
    const phoneMatch = text.match(phoneRegex);
    return phoneMatch ? phoneMatch[0] : null;
}

// Extract LinkedIn URL using regex
const extractLinkedIn = (text) => {
    const linkedInMatch = text.match(linkedInRegex);
    return linkedInMatch ? linkedInMatch[0] : null;
}

const extractCountry = (text) => {
    const doc = nlp(text);
    const locations = doc.places().out('array').flatMap(l => l.split(',').map(l => l.trim())); // Extracts locations (cities, countries, etc.)

    console.log(locations)

    // Heuristic: Filter out the country if present
    const countries = iso31661.filter(country => locations.includes(country.name));

    return countries.length > 0 ? countries[0].name : null; // Return the first country found, if any
}

const extractLanguages = (text) => {
    const foundLanguages = languages.filter(language => {
        const regex = new RegExp(`\\b${language.name.trim()}\\b`, 'i');
        return regex.test(text);
    });
    return foundLanguages.length > 0 ? foundLanguages : null;
}

// Extract WhatsApp link using regex
const extractWhatsApp = (text) => {
    const whatsAppMatch = text.match(whatsAppRegex);
    return whatsAppMatch ? whatsAppMatch[0] : null;
}

// Extract Telegram link using regex
const extractTelegram = (text) => {
    // First, try to match a full Telegram URL
    const telegramUrlMatch = text.match(telegramUrlRegex);
    if (telegramUrlMatch) {
        return telegramUrlMatch[0]; // Return the first Telegram URL found
    }

    // If no URL is found, try to match a Telegram handle (e.g., @username)
    const telegramHandleMatch = text.match(telegramHandleRegex);
    return telegramHandleMatch ? telegramHandleMatch[0] : null; // Return the handle if found, or null
}

const currencyMap = {
    '$': 'USD',
    '€': 'EUR',
    '£': 'GBP'
};
// Extract desired salary as an object with numerical value and currency code
const extractSalary = (text) => {

    const salaryMatch = salaryRegex.exec(text);

    if (salaryMatch && salaryMatch.groups.amount) {
        const amount = parseFloat(salaryMatch.groups.amount.replace(/,/g, '')); // Remove commas and parse to float
        const currencySymbol = salaryMatch.groups.currencySymbol || salaryMatch.groups.currencySymbol2 || '$'; // Default to USD if no symbol
        const currencyCode = currencyMap[currencySymbol] || 'USD'; // Default to USD

        return {
            amount: amount,
            currency: currencyCode
        };
    }

    return null; // Return null if no salary is found
}
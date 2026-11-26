/**
 * Cloudflare Worker PDF Text/Image Extractor + Gemini AI & Full Rule-Based Teletalk Parser
 */

function bytesToBase64(uint8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function findSequence(haystack, needle, start = 0) {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const latin1Decoder = new TextDecoder('latin1');
const asciiEncoder = new TextEncoder();

async function inflateDeflate(bytes) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const outBuf = await new Response(ds.readable).arrayBuffer();
      return latin1Decoder.decode(outBuf);
    } catch {
      // try next deflate format
    }
  }
  return '';
}

function unescapePdfString(str) {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

function parsePdfTextOperators(contentStr) {
  const lines = [];
  let currentLine = '';
  const tokens = contentStr.match(/(\((?:\\.|[^\\()])*\)\s*Tj|\[(?:\\.|[^\]])*\]\s*TJ|\bT\*|\bTd\b|\bTD\b|\bET\b)/g) || [];
  for (const tok of tokens) {
    if (tok === 'T*' || tok === 'Td' || tok === 'TD' || tok === 'ET') {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
    } else if (tok.endsWith('Tj')) {
      const m = tok.match(/^\((.*)\)\s*Tj$/s);
      if (m) currentLine += unescapePdfString(m[1]) + ' ';
    } else if (tok.endsWith('TJ')) {
      const parts = tok.match(/\((?:\\.|[^\\()])*\)|-?\d+(?:\.\d+)?/g) || [];
      let joined = '';
      for (const p of parts) {
        if (p.startsWith('(')) {
          joined += unescapePdfString(p.slice(1, -1));
        } else if (parseFloat(p) <= -120 && joined && !joined.endsWith(' ')) {
          joined += ' ';
        }
      }
      currentLine += joined + ' ';
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join('\n');
}

export function extractEmbeddedImages(uint8) {
  const images = [];
  const soiSig = new Uint8Array([0xff, 0xd8, 0xff]);
  const eoiSig = new Uint8Array([0xff, 0xd9]);
  let start = 0;

  while (start < uint8.length && images.length < 6) {
    const soi = findSequence(uint8, soiSig, start);
    if (soi === -1) break;
    const eoi = findSequence(uint8, eoiSig, soi + 3);
    if (eoi === -1) break;
    const imgBytes = uint8.subarray(soi, eoi + 2);
    if (imgBytes.length > 4000) {
      images.push({
        bytes: imgBytes,
        base64: bytesToBase64(imgBytes),
        mimeType: 'image/jpeg'
      });
    }
    start = eoi + 2;
  }
  return images;
}

export async function extractTextFromPdfStream(uint8) {
  const chunks = [];
  const streamToken = asciiEncoder.encode('stream');
  const endstreamToken = asciiEncoder.encode('endstream');
  let pos = 0;

  while (pos < uint8.length) {
    const streamStart = findSequence(uint8, streamToken, pos);
    if (streamStart === -1) break;

    let dataStart = streamStart + 6;
    if (uint8[dataStart] === 0x0d && uint8[dataStart + 1] === 0x0a) dataStart += 2;
    else if (uint8[dataStart] === 0x0a || uint8[dataStart] === 0x0d) dataStart += 1;

    const streamEnd = findSequence(uint8, endstreamToken, dataStart);
    if (streamEnd === -1) break;

    const rawStream = uint8.subarray(dataStart, streamEnd);
    const headerSlice = latin1Decoder.decode(uint8.subarray(Math.max(0, streamStart - 200), streamStart));

    if (!/\/Subtype\s*\/Image/i.test(headerSlice)) {
      let contentStr = '';
      if (/\/FlateDecode/i.test(headerSlice)) {
        contentStr = await inflateDeflate(rawStream);
      } else {
        contentStr = latin1Decoder.decode(rawStream);
      }
      if (contentStr && (contentStr.includes('Tj') || contentStr.includes('TJ'))) {
        chunks.push(parsePdfTextOperators(contentStr));
      }
    }
    pos = streamEnd + 9;
  }

  return chunks.join('\n').replace(/[ \t]+/g, ' ').trim();
}

export async function extractProfileFromPdf(pdfBytes, customApiKey = '', env = {}, ocrTextOverride = '') {
  const cleanOverride = String(ocrTextOverride || '').trim();
  const images = cleanOverride ? [] : extractEmbeddedImages(pdfBytes);
  const rawText = cleanOverride || (await extractTextFromPdfStream(pdfBytes));
  const apiKey = customApiKey || env.GEMINI_API_KEY || '';
  const model = env.GEMINI_MODEL || 'gemini-1.5-flash';

  if (apiKey && !cleanOverride) {
    try {
      const geminiData = await callGeminiApi(pdfBytes, images, rawText, apiKey, model);
      if (geminiData && geminiData.applicantName) {
        return {
          ...geminiData,
          extractionMethod: 'gemini-ai',
          detectedImagesCount: images.length,
          needsClientOcr: false
        };
      }
    } catch (err) {
      console.warn('Gemini Worker API error, falling back:', err.message);
    }
  }

  const parsed = parseFallback(rawText);
  const hasUsefulData = Boolean(parsed.applicantName || parsed.mobile || parsed.nid);
  const needsClientOcr = !cleanOverride && (!hasUsefulData || rawText.trim().length < 40);

  return {
    ...parsed,
    extractionMethod: cleanOverride ? 'browser-ocr' : 'rule-based-worker',
    detectedImagesCount: images.length,
    needsClientOcr,
    extractedImages: needsClientOcr ? images.slice(0, 4).map(i => ({ base64: i.base64, mimeType: i.mimeType })) : []
  };
}

async function callGeminiApi(pdfBytes, images, rawText, apiKey, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const promptText = `You are an expert OCR and data extraction system for Bangladeshi Government Job Applications (Teletalk Applicant Copies). Return strictly a valid JSON object matching the schema with applicantName, applicantNameBn, fatherName, fatherNameBn, motherName, motherNameBn, dob (YYYY-MM-DD), gender, religion, nationality, nid, birthReg, passport, maritalStatus, spouseName, mobile, email, quota, departmentalStatus, presentAddress {careOf, village, district, upazila, postOffice, postCode}, permanentAddress {sameAsPresent, careOf, village, district, upazila, postOffice, postCode}, education {jsc, ssc, hsc, graduation, masters}. Set missing education levels to null. Output pure JSON only.`;

  const parts = [{ text: promptText }];
  if (images.length > 0) {
    for (const img of images.slice(0, 4)) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
  } else {
    parts.push({ inlineData: { mimeType: 'application/pdf', data: bytesToBase64(pdfBytes) } });
  }
  if (rawText) {
    parts.push({ text: `Raw Text Stream:\n${rawText.slice(0, 5000)}` });
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return JSON.parse(text.replace(/^```json/m, '').replace(/^```/m, '').replace(/```$/m, '').trim());
}

function extractSubject(str, examHint = '') {
  if (!str) return '';
  const cleaned = str
    .replace(/\bIslamic\s+Arabic\s+University\b/gi, '')
    .replace(/\bBangladesh\s+Madrasah\s+Education\s+Board\b/gi, '')
    .replace(/\bUniversity\s+of\s+(?:Dhaka|Rajshahi|Chittagong|Barishal|Science\s+&\s+Technology|Liberal\s+Arts|Asia\s+Pacific|[A-Z][a-z]+)\b/gi, '')
    .replace(/\b[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}\s+University\b/g, '');

  const subjects = [
    'Computer Science & Engineering', 'Computer Science', 'Software Engineering', 'Information Technology', 'CSE', 'EEE', 'ECE',
    'Electrical & Electronic Engineering', 'Civil Engineering', 'Electrical Engineering', 'Mechanical Engineering', 'Textile Engineering',
    'Islamic History & Culture', 'Islamic History', 'Islamic Studies', 'Islamic Theology', 'Al-Quran', 'Al-Hadith', 'Al-Fiqh', 'Usulul Fiqh', 'Fiqh', 'Tafsir', 'Hadith', 'Arabic Literature', 'Arabic', 'Dawah',
    'Public Administration', 'Business Administration', 'Human Resource Management', 'International Relations', 'Development Studies', 'Mass Communication', 'Library Science',
    'Mathematics', 'Applied Mathematics', 'Physics', 'Applied Physics', 'Chemistry', 'Applied Chemistry', 'Biochemistry', 'Microbiology', 'Biotechnology', 'Genetic Engineering',
    'Environmental Science', 'Soil Science', 'Food & Nutrition', 'Botany', 'Zoology', 'Statistics', 'Economics', 'Home Economics', 'English', 'Bangla', 'History',
    'Political Science', 'Sociology', 'Social Work', 'Anthropology', 'Criminology', 'Psychology', 'Accounting', 'Finance', 'Banking',
    'Management', 'Marketing', 'Law', 'Philosophy', 'Geography', 'Agriculture', 'Fisheries', 'Forestry', 'Veterinary', 'Pharmacy', 'Fine Arts',
    'Pass Course', 'General', 'BBA', 'MBA', 'LLB', 'LLM', 'MBBS'
  ];
  for (const s of subjects) {
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(cleaned)) return s;
  }
  if (examHint === 'Fazil' && /\bFazil\b.*\bFazil\b/i.test(str)) return 'Fazil';
  if (examHint === 'Kamil' && /\bKamil\b.*\bKamil\b/i.test(str)) return 'Kamil';
  return '';
}

function extractSubjectFromColumn(line, year) {
  if (!line || !year) return '';
  const beforeYear = line.split(year)[0];
  if (!beforeYear) return '';
  const m = beforeYear.match(/(?:\(Out\s*of(?:\s*[45]\)?)?|CGPA\s*[:\s]*[0-4](?:\.\d+|\d{2})|GPA\s*[:\s]*[0-5](?:\.\d+|\d{2})|\d\.\d{1,2}|Passed|(?:1st|2nd|3rd)\s*(?:Class|Division)|[45]\))\s+([A-Za-z][A-Za-z\s&.-]{2,35})$/i);
  if (m && m[1]) {
    const candidate = m[1].trim();
    if (!/^(?:N\/A|Out|of|University|College|Institute|National|Islamic|Dhaka|Rajshahi)$/i.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

/**
 * Full Rule-Based + OCR Parser for Bangladeshi Teletalk & Govt Job PDFs (works 100% without AI)
 */
export function parseFallback(text) {
  const profile = {
    applicantName: '',
    applicantNameBn: '',
    fatherName: '',
    fatherNameBn: '',
    motherName: '',
    motherNameBn: '',
    dob: '',
    gender: 'Male',
    religion: 'Islam',
    nationality: 'Bangladeshi',
    nid: '',
    birthReg: '',
    passport: '',
    maritalStatus: 'Single',
    spouseName: '',
    mobile: '',
    email: '',
    quota: 'Not Applicable',
    departmentalStatus: 'Not Applicable',
    presentAddress: {
      careOf: '',
      village: '',
      district: '',
      upazila: '',
      postOffice: '',
      postCode: ''
    },
    permanentAddress: {
      sameAsPresent: true,
      careOf: '',
      village: '',
      district: '',
      upazila: '',
      postOffice: '',
      postCode: ''
    },
    education: {
      jsc: null,
      ssc: null,
      hsc: null,
      graduation: null,
      masters: null
    }
  };

  if (!text) return profile;

  const normalizedText = String(text)
    .normalize('NFC')
    .replace(/\u09AF\u09BC/g, '\u09DF')
    .replace(/\u09A1\u09BC/g, '\u09DC')
    .replace(/\u09A2\u09BC/g, '\u09DD')
    .replace(/([\u0980-\u09FF])\s+([\u0981-\u0983\u09BC\u09BE-\u09CC\u09CD\u09D7])/g, '$1$2')
    .replace(/([\u0980-\u09FF])\s+([\u0981-\u0983\u09BC\u09BE-\u09CC\u09CD\u09D7])/g, '$1$2')
    .replace(/\u09CD\s+([\u0995-\u09B9\u09DC-\u09DF])/g, '\u09CD$1')
    .replace(/\b([JSBHM])\s*\.\s*([SDC])\s*\.\s*C\b/gi, '$1.$2.C')
    .replace(/\b([BM])\s*\.\s*([AS])\s*\.\s*S\b/gi, '$1.$2.S')
    .replace(/\b([1-5])\s*\.\s*(\d{1,2})\b/g, '$1.$2');

  const lines = normalizedText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const isKnownLabelLine = (str) =>
    /^(?:Applicant(?:'s)?\s*Name|Father(?:'s)?\s*Name|Mother(?:'s)?\s*Name|Spouse(?:'s)?\s*Name|Date\s*of\s*Birth|Nationality|Religion|Gender|Sex\b|National\s*ID|NID\b|Birth\s*Reg|Passport|Marital\s*Status|Mobile|E-?mail|Quota|Departmental\s*Status|Present\s*Address|Permanent\s*Address|Care\s*Of|Vill|District|Upazila|Post\s*Office|Post\s*Code|আবেদনকার[ীি]র|প্রার্থীর|পিতার|বাবার|মাতার|মা[য়ে]য়ের|মায়ের)/i.test(str);

  const inlineBoundaryRe = /\s{2,}(?:Applicant(?:'s)?\s*Name|Candidate(?:'s)?\s*Name|Father(?:'s)?\s*Name|Mother(?:'s)?\s*Name|Spouse(?:'s)?\s*Name|Date\s*of\s*Birth|Nationality|Religion|Gender|Sex\b|National\s*ID|NID\b|Birth\s*Reg|Passport|Marital\s*Status|Mobile|Phone|E-?mail|Quota|Departmental\s*Status|Present\s*Address|Permanent\s*Address|আবেদনকার[ীি]র|প্রার্থীর|পিতার|বাবার|মাতার|মা[য়ে]য়ের|মায়ের)\b/i;

  const extractAfterLabel = (labelRegex, filterFn = null) => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(labelRegex);
      if (m) {
        let rest = line.slice(m.index + m[0].length);
        const cut = rest.search(inlineBoundaryRe);
        if (cut > 0) rest = rest.slice(0, cut);
        rest = rest.trim().replace(/^(?:\(\s*(?:বাংলায়?|বাংলায়?|in\s*bangla|bn)\s*\)\s*)?(?:[:\]|;=—-]+|[B83qg]\b)\s*/i, '').trim();
        if (rest && (!filterFn || filterFn(rest))) return { value: rest, lineIndex: i };
        // Check next line if value wrapped onto next line
        if (i + 1 < lines.length && !isKnownLabelLine(lines[i + 1])) {
          let nextVal = lines[i + 1];
          const nCut = nextVal.search(inlineBoundaryRe);
          if (nCut > 0) nextVal = nextVal.slice(0, nCut);
          nextVal = nextVal.replace(/^[:\]|;=—-]+\s*/, '').trim();
          if (nextVal && (!filterFn || filterFn(nextVal))) return { value: nextVal, lineIndex: i + 1 };
        }
      }
    }
    return { value: '', lineIndex: -1 };
  };

  const cleanEnglishName = (raw) => {
    if (!raw) return '';
    let s = raw.replace(/[-+*/\\|()[\]{}].*$/, '').trim();
    s = s.replace(/\s+[a-z]{1,2}$/, '').trim();
    s = s.replace(/[^A-Za-z.\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.toUpperCase();
  };

  const cleanBanglaName = (raw) => {
    if (!raw) return '';
    const stripped = String(raw)
      .normalize('NFC')
      .replace(/\u09AF\u09BC/g, '\u09DF')
      .replace(/\u09A1\u09BC/g, '\u09DC')
      .replace(/\u09A2\u09BC/g, '\u09DD')
      .replace(/\(\s*(?:বাংলায়?|বাংলা|bn|in\s*bangla)\s*\)/gi, ' ')
      .replace(/^(?:(?:Applicant|Candidate|Father|Mother)(?:'s)?\s*Name\s*|(?:আবেদনকার[ীি]র|প্রার্থীর|পিতার|বাবার|মাতার|মা[য়ে]য়ের|মায়ের)\s*নাম|নাম)\s*[:\]|;=—-]*\s*/i, '');
    const m = stripped.match(/([\u0980-\u09E5\u09F0-\u09FF\u200C\u200D][\u0980-\u09E5\u09F0-\u09FF\u200C\u200D.\s-]*)/);
    return m ? m[1].replace(/\s+/g, ' ').replace(/[.\s-]+$/, '').trim() : '';
  };
  const hasBanglaName = (v) => Boolean(cleanBanglaName(v));

  // 1. Names (English & Bengali)
  const appNameRes = extractAfterLabel(/(?:Applicant(?:'s)?|Candidate(?:'s)?|Name\s*of\s*Applicant)\s*Name?(?!\s*\(\s*(?:বাংলা|bn|in\s*bangla))/i);
  if (appNameRes.value) profile.applicantName = cleanEnglishName(appNameRes.value);

  const appNameBnRes = extractAfterLabel(/(?:আবেদনকার[ীি]র\s*নাম(?:\s*\(\s*বাংলায়?\s*\))?|প্রার্থীর\s*নাম(?:\s*\(\s*বাংলায়?\s*\))?|(?:Applicant|Candidate)(?:'s)?\s*Name\s*\(\s*(?:বাংলায়?|bn|in\s*bangla)\s*\)|নাম\s*\(\s*বাংলায়?\s*\))/i, hasBanglaName);
  if (appNameBnRes.value) {
    profile.applicantNameBn = cleanBanglaName(appNameBnRes.value);
  } else if (appNameRes.lineIndex >= 0 && lines[appNameRes.lineIndex + 1]) {
    const bn = cleanBanglaName(lines[appNameRes.lineIndex + 1]);
    if (bn && !bn.includes('আবেদনকার') && !bn.includes('পিতার')) profile.applicantNameBn = bn;
  }

  const fatherRes = extractAfterLabel(/Father(?:'s)?\s*Name(?!\s*\(\s*(?:বাংলা|bn|in\s*bangla))/i);
  if (fatherRes.value) profile.fatherName = cleanEnglishName(fatherRes.value);

  const fatherBnRes = extractAfterLabel(/(?:পিতার\s*নাম(?:\s*\(\s*বাংলায়?\s*\))?|বাবার\s*নাম|Father(?:'s)?\s*Name\s*\(\s*(?:বাংলায়?|bn|in\s*bangla)\s*\))/i, hasBanglaName);
  if (fatherBnRes.value) {
    profile.fatherNameBn = cleanBanglaName(fatherBnRes.value);
  } else if (fatherRes.lineIndex >= 0 && lines[fatherRes.lineIndex + 1] && !/Mother/i.test(lines[fatherRes.lineIndex + 1])) {
    const afterColon = lines[fatherRes.lineIndex + 1].split(/[:\]]/).pop();
    const bn = cleanBanglaName(afterColon);
    if (bn && !bn.includes('মাতার')) profile.fatherNameBn = bn;
  }

  const motherRes = extractAfterLabel(/Mother(?:'s)?\s*Name(?!\s*\(\s*(?:বাংলা|bn|in\s*bangla))/i);
  if (motherRes.value) profile.motherName = cleanEnglishName(motherRes.value);

  const motherBnRes = extractAfterLabel(/(?:মাতার\s*নাম(?:\s*\(\s*বাংলায়?\s*\))?|মা[য়ে]য়ের\s*নাম|মায়ের\s*নাম|Mother(?:'s)?\s*Name\s*\(\s*(?:বাংলায়?|bn|in\s*bangla)\s*\))/i, hasBanglaName);
  if (motherBnRes.value) {
    profile.motherNameBn = cleanBanglaName(motherBnRes.value);
  } else if (motherRes.lineIndex >= 0 && lines[motherRes.lineIndex + 1] && !/Date\s*of\s*Birth/i.test(lines[motherRes.lineIndex + 1])) {
    const afterColon = lines[motherRes.lineIndex + 1].split(/[:\]]/).pop();
    const bn = cleanBanglaName(afterColon);
    if (bn) profile.motherNameBn = bn;
  }

  // 2. Date of Birth (YYYY-MM-DD)
  const dobRes = extractAfterLabel(/Date\s*of\s*Birth|\bDOB\b/i);
  const dobSource = dobRes.value || text;
  const isoDobMatch = dobSource.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const dobMatch = dobSource.match(/\b(\d{1,2})[-/.\s]([A-Za-z]{3,9}|\d{1,2})[-/.\s](\d{4})\b/);
  if (isoDobMatch) {
    profile.dob = `${isoDobMatch[1]}-${String(isoDobMatch[2]).padStart(2, '0')}-${String(isoDobMatch[3]).padStart(2, '0')}`;
  } else if (dobMatch) {
    const day = String(dobMatch[1]).padStart(2, '0');
    let month = dobMatch[2].toLowerCase();
    const year = dobMatch[3];
    const monthMap = {
      jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
      apr: '04', april: '04', may: '05', jun: '06', june: '06',
      jul: '07', july: '07', aug: '08', august: '08', sep: '09', sept: '09', september: '09',
      oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12'
    };
    if (monthMap[month]) {
      month = monthMap[month];
    } else if (/^\d{1,2}$/.test(month)) {
      month = String(month).padStart(2, '0');
    }
    if (/^\d{2}$/.test(month)) {
      profile.dob = `${year}-${month}-${day}`;
    }
  }

  // 3. Nationality, Religion, Gender
  const natRes = extractAfterLabel(/Nationality/i);
  if (natRes.value) {
    if (/Bangladeshi/i.test(natRes.value)) profile.nationality = 'Bangladeshi';
    else profile.nationality = natRes.value.replace(/[^A-Za-z\s]/g, '').trim() || 'Bangladeshi';
  }

  const relRes = extractAfterLabel(/Religion/i);
  const relSrc = relRes.value || text;
  if (/\bIslam\b/i.test(relSrc)) profile.religion = 'Islam';
  else if (/\bHindu/i.test(relSrc)) profile.religion = 'Hinduism';
  else if (/\bBuddh/i.test(relSrc)) profile.religion = 'Buddhism';
  else if (/\bChrist/i.test(relSrc)) profile.religion = 'Christianity';
  else if (relRes.value && /\bOther\b/i.test(relRes.value)) profile.religion = 'Other';

  const genRes = extractAfterLabel(/\b(?:Gender|Sex)\b/i);
  const genSrc = genRes.value || text;
  if (/\bFemale\b|মহিলা/i.test(genSrc)) profile.gender = 'Female';
  else if (/\bMale\b|পুরুষ/i.test(genSrc)) profile.gender = 'Male';
  else if (/\bThird\s*Gender\b|তৃতীয়\s*লিঙ্গ/i.test(genSrc)) profile.gender = 'Third Gender';

  // 4. NID, Birth Reg, Passport
  const nidRes = extractAfterLabel(/(?:National\s*ID(?:\s*\(?NID\)?)?(?:\s*(?:No|Number))?|\bNID\s*(?:No|Number)?\b)/i);
  if (nidRes.value && !/^(?:N\/A|No|None|Nil|-)$/i.test(nidRes.value)) {
    const nidMatch = nidRes.value.match(/\b(\d{10}|\d{13}|\d{17})\b/);
    if (nidMatch) profile.nid = nidMatch[1];
  } else if (!nidRes.value) {
    const nidMatch = text.match(/National\s*ID[^\n\d]{0,20}(\d{10}|\d{13}|\d{17})/i);
    if (nidMatch) profile.nid = nidMatch[1];
  }

  const bregRes = extractAfterLabel(/Birth\s*Reg(?:istration)?(?:\s*(?:ID|No|Number))?/i);
  if (bregRes.value && !/^(?:N\/A|No|None|Nil|-)$/i.test(bregRes.value)) {
    const bm = bregRes.value.match(/\d{10,20}/);
    if (bm) profile.birthReg = bm[0];
  }

  const passRes = extractAfterLabel(/Passport\s*(?:ID|No|Number)?/i);
  if (passRes.value && !/^(?:N\/A|No|None|Nil|Not\s*Applicable|Not\s*Available|-)$/i.test(passRes.value)) {
    const pm = passRes.value.match(/\b([A-Z]{0,3}\d[A-Z0-9]{4,14})\b/i);
    if (pm) profile.passport = pm[1].toUpperCase();
  }

  // 5. Marital Status & Spouse Name
  const marRes = extractAfterLabel(/Marital\s*Status/i);
  const marSrc = marRes.value || text;
  if (/\bMarried\b/i.test(marSrc)) {
    profile.maritalStatus = 'Married';
  } else if (/\bSingle\b|\bUnmarried\b/i.test(marSrc)) {
    profile.maritalStatus = 'Single';
  }
  const spouseRes = extractAfterLabel(/Spouse(?:'s)?\s*Name/i);
  const spouseCandidate = spouseRes.value || (marSrc.match(/Spouse\s*(?:Name)?\s*[:\]]?\s*([A-Za-z.\s'-]+)/i)?.[1] || '');
  if (spouseCandidate && !/^(?:N\/A|No|None|Nil|-)$/i.test(spouseCandidate.trim())) {
    profile.spouseName = cleanEnglishName(spouseCandidate);
  }

  // 6. Mobile & Email
  const mobRes = extractAfterLabel(/Mobile\s*(?:Number|No)?|\bPhone\b|\bContact\s*No\b/i);
  const mobMatch = (mobRes.value || text).match(/(?:\+?88[-\s]?)?(01[3-9](?:[\s-]?\d){8})\b/);
  if (mobMatch) profile.mobile = mobMatch[1].replace(/\D/g, '');

  const emailRes = extractAfterLabel(/E-?mail(?:\s*Address)?/i);
  const emailMatch = (emailRes.value || text).match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) profile.email = emailMatch[1].toLowerCase();

  // 7. Quota & Departmental Status
  const quotaRes = extractAfterLabel(/\bQuota\b/i);
  if (quotaRes.value) {
    if (/Not\s*Applicable|\bNone\b|\bN\/A\b/i.test(quotaRes.value)) profile.quota = 'Not Applicable';
    else if (/Freedom\s*Fighter/i.test(quotaRes.value)) profile.quota = 'Child of Freedom Fighter';
    else if (/Physically|Disabled|Autism/i.test(quotaRes.value)) profile.quota = 'Physically Challenged';
    else if (/Ethnic/i.test(quotaRes.value)) profile.quota = 'Ethnic Minority';
    else profile.quota = quotaRes.value.replace(/\s+/g, ' ').trim();
  }

  const depRes = extractAfterLabel(/Departmental\s*Status/i);
  if (depRes.value) {
    if (/Not\s*Applicable|\bNone\b|\bN\/A\b/i.test(depRes.value)) profile.departmentalStatus = 'Not Applicable';
    else if (/Govt/i.test(depRes.value)) profile.departmentalStatus = 'Govt. Employee';
    else profile.departmentalStatus = depRes.value.replace(/\s+/g, ' ').trim();
  }

  // 8. Present & Permanent Address (Section-Aware: supports BOTH 2-column AND stacked sections)
  const cleanAddrPrefix = (v) =>
    String(v || '')
      .trim()
      .replace(/^(?:\/?\s*(?:Town|Mahalla|Road|House|Flat|P\.?S\.?|Thana)(?:\s*\/\s*(?:Town|Mahalla|Road|House|Flat|P\.?S\.?|Thana))*\s*\/?)+/i, '')
      .replace(/^[\/\s]+/, '')
      .replace(/^(?:[:\]|;=—-]+|[B83qg]\b)\s*/i, '')
      .replace(/^[\/\s]+/, '')
      .trim();

  const applyAddressField = (targetObj, field, val) => {
    if (!val || targetObj[field]) return;
    if (/^(?:House\/?\s*Flat|Road\/?\s*House|Town\/?\s*Road)$/i.test(val.trim())) return;
    if (field === 'careOf') targetObj.careOf = cleanEnglishName(val);
    else if (field === 'village') targetObj.village = val.replace(/\s*\/\s*(?:Town|Mahalla|Road|House|Flat).*$/i, '').trim();
    else if (field === 'district') targetObj.district = val.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/[^A-Za-z`\s'-]/g, '').trim();
    else if (field === 'upazila') targetObj.upazila = val.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/[^A-Za-z\s'-]/g, '').trim();
    else if (field === 'postOffice') targetObj.postOffice = val.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/[^A-Za-z\s'-]/g, '').trim();
    else if (field === 'postCode') {
      const pc = val.match(/\d{4}/);
      if (pc) targetObj.postCode = pc[0];
    }
  };

  const addrFields = [
    { key: 'careOf', regex: /Care\s*Of|C\/O/i },
    { key: 'village', regex: /(?:Vill(?:age)?(?:\s*\/\s*(?:Town|Mahalla|Road|House|Flat))*\s*\/?|Road\s*\/\s*House|House\s*\/\s*Flat)/i },
    { key: 'district', regex: /\bDistrict\b/i },
    { key: 'upazila', regex: /Upazila(?:\s*\/\s*(?:P\.?S\.?|Thana))?/i },
    { key: 'postOffice', regex: /Post\s*Office|\bP\.?O\.?\b/i },
    { key: 'postCode', regex: /Post(?:al)?\s*Code/i }
  ];

  const hasAddressHeader = lines.some(l => /Present\s*Address|বর্তমান\s*ঠিকানা|Permanent\s*Address|স্থায়ী\s*ঠিকানা/i.test(l));
  let addrSection = hasAddressHeader ? 'wait' : 'auto';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasPresHead = /Present\s*Address|বর্তমান\s*ঠিকানা/i.test(line);
    const hasPermHead = /Permanent\s*Address|স্থায়ী\s*ঠিকানা/i.test(line);

    if (hasPresHead && hasPermHead) {
      addrSection = 'two-col';
      continue;
    }
    if (hasPresHead) {
      addrSection = 'present';
      continue;
    }
    if (hasPermHead) {
      addrSection = 'permanent';
      if (/Same\s*as\s*Present/i.test(line)) {
        profile.permanentAddress = { ...profile.presentAddress, sameAsPresent: true };
      }
      continue;
    }
    if (/^(?:Academic|Educational)\s*(?:Qualification|Info)|\bEducation\b|\bS\.?S\.?C\b|\bClass\s*Eight\b/i.test(line)) {
      addrSection = 'done';
      continue;
    }
    if (addrSection === 'permanent' && /Same\s*as\s*Present/i.test(line)) {
      profile.permanentAddress = { ...profile.presentAddress, sameAsPresent: true };
      continue;
    }
    if (addrSection === 'wait' || addrSection === 'done') continue;

    for (const f of addrFields) {
      const matches = [...line.matchAll(new RegExp(f.regex.source, 'gi'))];
      if (matches.length >= 2) {
        const leftVal = cleanAddrPrefix(line.slice(matches[0].index + matches[0][0].length, matches[1].index));
        const rightVal = cleanAddrPrefix(line.slice(matches[1].index + matches[1][0].length));
        applyAddressField(profile.presentAddress, f.key, leftVal);
        applyAddressField(profile.permanentAddress, f.key, rightVal);
      } else if (matches.length === 1) {
        let val = cleanAddrPrefix(line.slice(matches[0].index + matches[0][0].length));
        if (!val && i + 1 < lines.length && !isKnownLabelLine(lines[i + 1])) {
          val = cleanAddrPrefix(lines[i + 1]);
        }
        if (addrSection === 'permanent') {
          applyAddressField(profile.permanentAddress, f.key, val);
        } else {
          applyAddressField(profile.presentAddress, f.key, val);
          if (addrSection === 'auto') applyAddressField(profile.permanentAddress, f.key, val);
        }
      }
    }
  }

  if (!profile.permanentAddress.district && profile.presentAddress.district) {
    profile.permanentAddress = { ...profile.presentAddress, sameAsPresent: true };
  } else {
    profile.permanentAddress.sameAsPresent =
      profile.presentAddress.district === profile.permanentAddress.district &&
      profile.presentAddress.postCode === profile.permanentAddress.postCode &&
      profile.presentAddress.village === profile.permanentAddress.village;
  }

  // 9. Educational Qualifications
  const bdBoards = ['Rajshahi', 'Dhaka', 'Cumilla', 'Chattogram', 'Jashore', 'Barishal', 'Sylhet', 'Dinajpur', 'Mymensingh', 'Madrasah', 'Technical', 'BTEB', 'Comilla', 'Chittagong', 'Jessore', 'Barisal'];
  const normalizeBoardName = (b) => {
    if (/^comilla$/i.test(b)) return 'Cumilla';
    if (/^chittagong$/i.test(b)) return 'Chattogram';
    if (/^jessore$/i.test(b)) return 'Jashore';
    if (/^barisal$/i.test(b)) return 'Barishal';
    return b;
  };
  const matchBoard = (str) => {
    if (!str) return '';
    for (const b of bdBoards) {
      if (new RegExp(`\\b${b}\\b`, 'i').test(str) || new RegExp(b, 'i').test(str)) return normalizeBoardName(b);
    }
    if (/ajshahi/i.test(str)) return 'Rajshahi';
    if (/haka/i.test(str)) return 'Dhaka';
    return '';
  };

  const extractInstitute = (line, ctx = '') => {
    const stripExamPrefix = (s) =>
      String(s || '')
        .replace(/^(?:Education\s*[1-5][:\s-]*)/i, '')
        .replace(/^(?:Fazil|Fajil|Kamil|B\.?\s*S\.?\s*C(?:\s*\(?Engg\.?|Engineering\)?)?|B\.?\s*A|B\.?\s*Com|B\.?\s*S\.?\s*S|B\.?\s*B\.?\s*A|M\.?\s*B\.?\s*B\.?\s*S|LL\.?\s*B|B\.?\s*Ed|M\.?\s*S\.?\s*C|M\.?\s*A|M\.?\s*Com|M\.?\s*S\.?\s*S|M\.?\s*B\.?\s*A|LL\.?\s*M|M\.?\s*Ed|Honou?rs|Bachelor|Graduation|Degree(?:\s*\(?Pass\)?)?|Master(?:'s|s)?)(?:\s*\((?:Honou?rs|Pass|Engineering|Engg\.?)\))?\s*/i, '')
        .trim();

    const patterns = [
      /(Islamic\s+Arabic\s+University(?:\s*\([^)]+\))?|Bangladesh\s+Madrasah\s+Education\s+Board)/i,
      /(National\s+University(?:\s*\([^)]+\))?)/i,
      /(University\s+of\s+[A-Za-z&.\s'-]{3,45}?)(?=\s+(?:N\/A|CGPA|GPA|1st|2nd|3rd|Passed|\d{4,8}|\d\.\d{1,2})\b|$)/i,
      /([A-Za-z][A-Za-z.'&\s-]{2,55}?\s+(?:University(?:\s+of\s+[A-Za-z&.\s'-]{2,35})?|Medical\s+College|Engineering\s+College|Govt\.?\s+College|College|Institute|Polytechnic|Madrasah|Alia))(?=\s+(?:N\/A|CGPA|GPA|1st|2nd|3rd|Passed|\d{4,8}|\d\.\d{1,2})\b|$)/i,
      /([A-Za-z][A-Za-z.'&-]+(?:\s+[A-Za-z][A-Za-z.'&-]+){0,5}\s+(?:University|College|Institute|Madrasah|Alia))/i
    ];
    for (const rawSrc of [line, ctx]) {
      const src = stripExamPrefix(rawSrc);
      if (!src) continue;
      for (const p of patterns) {
        const m = src.match(p);
        if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim();
      }
      // Positional table fallback: text before N/A or CGPA/GPA/Class/Roll
      const posM = src.match(/^([A-Za-z][A-Za-z0-9.'&(),\s-]{3,65}?)\s+(?:N\/A\s+)?(?:CGPA|GPA|(?:1st|2nd|3rd)\s*(?:Class|Division)|Passed|\d\.\d{2}\s*\(Out\s*of)/i);
      if (posM && posM[1] && !/^(?:Examination|Board|University|Institute|Subject|Result)$/i.test(posM[1].trim())) {
        return posM[1].replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };

  const EDU_LEVEL_PATTERNS = [
    { key: 'jsc', re: /\b(?:Education\s*1\b|Class\s*(?:Eight|8)\b|Eight\s*Pass\b|8th\s*(?:Class|Pass)\b|Junior\s*School\s*Certificate\b|J\.?\s*[S5]\.?\s*C(?=\b|[A-Z(\s])|J\.?\s*D\.?\s*C(?=\b|[A-Z(\s]))/i },
    { key: 'ssc', re: /\b(?:Education\s*2\b|S\.?\s*S\.?\s*C|Dakhil|Secondary\s*School\s*Certificate)\b/i },
    { key: 'hsc', re: /\b(?:Education\s*3\b|H\.?\s*S\.?\s*C|Alim|Diploma(?:\s+in)?|Higher\s*Secondary)\b/i },
    { key: 'graduation', re: /\b(?:Education\s*4\b|Fazil|Fajil|B\.?\s*S\.?\s*C|B\.?\s*A\b|B\.?\s*Com|B\.?\s*S\.?\s*S|B\.?\s*B\.?\s*A|LL\.?\s*B|M\.?\s*B\.?\s*B\.?\s*S|B\.?\s*Ed|Honou?rs|Bachelor|Graduation|Degree\s*\(?Pass\)?)\b/i },
    { key: 'masters', re: /\b(?:Education\s*5\b|Kamil|M\.?\s*S\.?\s*C|M\.?\s*A\b|M\.?\s*Com|M\.?\s*S\.?\s*S|M\.?\s*B\.?\s*A|LL\.?\s*M|M\.?\s*Ed|Master(?:'s|s)?)\b/i }
  ];

  const detectEduLevel = (str) => {
    if (!str) return null;
    if (/^Education\s*1\b/i.test(str)) return 'jsc';
    if (/^Education\s*2\b/i.test(str)) return 'ssc';
    if (/^Education\s*3\b/i.test(str)) return 'hsc';
    if (/^Education\s*4\b/i.test(str)) return 'graduation';
    if (/^Education\s*5\b/i.test(str)) return 'masters';
    for (const { key, re } of EDU_LEVEL_PATTERNS) {
      if (re.test(str)) return key;
    }
    return null;
  };

  const extractGroup = (line, ctx = '') => {
    const groupPatterns = [
      { regex: /\bSci?e?n[cl]e\b/i, val: 'Science' },
      { regex: /\bHumanit[il]e?s\b|\bHumanties\b/i, val: 'Humanities' },
      { regex: /\bBus[il]ness\s*Stud[il]e?s\b|\bB\.?\s*Studies\b/i, val: 'Business Studies' },
      { regex: /\bComm?[eo]rce\b/i, val: 'Commerce' },
      { regex: /\bArts\b/i, val: 'Arts' },
      { regex: /\bGeneral\b/i, val: 'General' },
      { regex: /\bMuzabbid\b/i, val: 'Muzabbid' },
      { regex: /\bHifzul\s*Quran\b/i, val: 'Hifzul Quran' },
      { regex: /\bBuilding\b[\s\S]{0,60}\bMaintenance\b/i, val: 'Building Maintenance' },
      { regex: /\b(General\s+Electrical\s+Works|General\s+Electronics|Electrical\s+Maintenance\s+Works|General\s+Mechanics|Civil\s+Construction|Dress\s+Making|Computer\s+(?:&|and)\s+Information\s+Technology|Refrigeration\s+(?:&|and)\s+Air\s+Conditioning|Plumbing\s+(?:&|and)\s+Pipe\s+Fitting|Welding\s+(?:&|and)\s+Fabrication|Computer(?:\s+Science)?(?:\s*&\s*Technology)?|Civil(?:\s+Technology)?|Electrical(?:\s+Technology)?|Mechanical(?:\s+Technology)?|Electronics|Automobile|Automotive|Architecture|Textile|Garments|Power|Telecommunication|Agriculture|Vocational)\b/i, val: null }
    ];
    for (const src of [line, ctx]) {
      if (!src) continue;
      for (const gp of groupPatterns) {
        const m = src.match(gp.regex);
        if (m) return gp.val || m[1].replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };

  const isEduFieldLabel = (str) => {
    if (!str) return false;
    // Do not misclassify wrapped closing paren fragments ("SCHOOL)   5)") or value lines ("GPA 3.65") as K-V labels
    if (/^(?:School|University|Institute|College|Board|GPA|CGPA|Result|Year|Group|Subject|Major|Duration)\s*\)/i.test(str)) return false;
    if (/^(?:GPA|CGPA)\s+[1-5](?:\.\d+)?\b/i.test(str)) return false;
    if (/^(?:School|University)\s+of\b/i.test(str)) return false;
    return /^(?:Examination|Board|Roll(?:\s*No)?|Group|School(?:\s*\/?\s*Institute)?|University(?:\s*\/?\s*Institute)?|Institute(?:\s*Name)?|Subject(?:\s*\/?\s*Major)?|Major|Result(?:\s*\/?\s*(?:GPA|CGPA))?|GPA|CGPA|Passing\s*Year|Year|Duration)\b/i.test(str);
  };

  const isEduTableHeader = (str) =>
    /^(?:Academic|Educational)\s*(?:Qualification|Info)|Examination\s+Board|Board\/University|Present\s*Address|Permanent\s*Address|Basic\s*&|Photo\s*&|Declaration|Verification|Signature/i.test(str);

  let lastConsumedEduLine = -1;

  const collectEduBlock = (startIdx, currentLevel) => {
    const startLine = lines[startIdx];
    const isSectionHeader = /^Education\s*[1-5]\b/i.test(startLine);
    const preLines = [];

    if (!isSectionHeader && !isEduFieldLabel(startLine)) {
      for (let p = startIdx - 1; p >= Math.max(lastConsumedEduLine + 1, startIdx - 3, 0); p--) {
        const pl = lines[p];
        if (detectEduLevel(pl) || isEduTableHeader(pl) || isEduFieldLabel(pl) || /^[^:]{2,30}:\s*\S/.test(pl) || isKnownLabelLine(pl)) break;
        // Only prepend if it looks like an upper wrapped table cell (e.g. Board/University or unclosed/closing paren) without its own passing year
        if (/\b(19\d{2}|20\d{2})\b/.test(pl)) break;
        preLines.unshift(pl);
      }
    }

    const blockLines = [...preLines, startLine];
    let endIdx = startIdx;
    let sawKvLabel = isSectionHeader || isEduFieldLabel(startLine);

    for (let k = startIdx + 1; k < Math.min(lines.length, startIdx + 15); k++) {
      const kl = lines[k];
      if (/^(?:Photo\s*&|Basic\s*&|Declaration|I\s+declare|Verification|Signature|NB:|Note:|Powered\s+by)/i.test(kl)) break;
      if (isEduTableHeader(kl)) break;

      if (isEduFieldLabel(kl)) sawKvLabel = true;

      const kLevel = detectEduLevel(kl);
      if (kLevel) {
        if (kLevel !== currentLevel) break;
        const allowSameLevel = isSectionHeader || /^Examination\b/i.test(kl);
        if (!allowSameLevel) break;
      }

      blockLines.push(kl);
      endIdx = k;

      // In table-row mode (not Key-Value mode), stop once the wrapped row has closed all parens and includes a passing year
      if (!sawKvLabel) {
        const joinedSoFar = blockLines.join(' ');
        const openParens = (joinedSoFar.match(/\(/g) || []).length;
        const closeParens = (joinedSoFar.match(/\)/g) || []).length;
        const hasYear = /\b(19\d{2}|20\d{2}|50(?:0\d|1\d|2[0-6]))\b/.test(joinedSoFar);
        if (hasYear && openParens <= closeParens) {
          // Peek 1 line ahead only if it is a standalone Duration / N/A wrap like "4 Years" or "N/A"
          if (k + 1 < lines.length && /^(?:[1-5]\s*Years?|N\/A)$/i.test(lines[k + 1].trim())) {
            blockLines.push(lines[k + 1]);
            endIdx = k + 1;
          }
          break;
        }
      }
    }

    return { blockLines, endIdx };
  };

  const getEduBlockVal = (blockLines, lblRe) => {
    for (let bIdx = 0; bIdx < blockLines.length; bIdx++) {
      const bl = blockLines[bIdx];
      const m = bl.match(lblRe);
      if (m) {
        const after = bl.slice(m.index + m[0].length);
        if (/^\s*[)(]/.test(after)) continue;
        const matchedWord = m[0].trim();
        const isSingleWord = !/[\s/]/.test(matchedWord);
        if (after.trim() && isSingleWord && !/^\s*[:\]|;=—-]/.test(after)) continue;
        let v = after.replace(/^[\s:\]|;=—-]+/, '').trim();
        if (!v && bIdx + 1 < blockLines.length && !isEduFieldLabel(blockLines[bIdx + 1])) {
          v = blockLines[bIdx + 1].replace(/^[\s:\]|;=—-]+/, '').trim();
        }
        if (v) return v;
      }
    }
    return '';
  };

  const mergeEduSlot = (slotKey, candidate, hasRealData, endIdx) => {
    if (!hasRealData) return false;
    const prev = profile.education[slotKey] || {};
    const merged = { ...candidate };
    for (const k of Object.keys(candidate)) {
      if (prev[k]) merged[k] = prev[k];
    }
    if (prev.result && prev.resultType) merged.resultType = prev.resultType;
    profile.education[slotKey] = merged;
    if (typeof endIdx === 'number' && endIdx > lastConsumedEduLine) {
      lastConsumedEduLine = endIdx;
    }
    return true;
  };

  const extractGpa = (src) => {
    if (!src) return '';
    const m = src.match(/(?:GPA|CGPA)\s*[:\s]*([1-5]\.\d{1,2})\b/i) || src.match(/\b([1-5]\.\d{1,2})\b/);
    if (m) return m[1];
    // Handle OCR dropped decimal point after GPA/CGPA (e.g. "GPA 365" -> "3.65")
    const noDot = src.match(/(?:GPA|CGPA)\s*[:\s]*([1-5])(\d{2})\b/i);
    if (noDot) {
      const val = parseFloat(`${noDot[1]}.${noDot[2]}`);
      if (val >= 1.0 && val <= 5.0) return `${noDot[1]}.${noDot[2]}`;
    }
    return '';
  };

  const extractEduYear = (kvYear, scope) => {
    const src = kvYear || scope;
    const yearM = src.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearM) return { year: yearM[1], rawMatch: yearM[1] };
    // Recover OCR leading-digit confusion like "5019" -> "2019" when positioned as trailing year
    const ocrYearM = src.match(/(?:GPA|CGPA|Out\s*of(?:\s*[45]\)?)?|Passed|Division|Class|Science|Arts|Humanities|Commerce|Business|Maintenance|N\/A|1st|2nd|3rd)[A-Za-z0-9\s.()/-]{0,45}\b(50(?:0\d|1\d|2[0-6]))\b(?=\s*(?:N\/A|[1-5]\s*Years?|$))/i);
    if (ocrYearM) {
      return { year: '2' + ocrYearM[1].slice(1), rawMatch: ocrYearM[1] };
    }
    return { year: '', rawMatch: '' };
  };

  const extractCleanRoll = (kvRoll, scopeStr, yearStr, rawYearMatch = '') => {
    let src = (kvRoll || scopeStr)
      .replace(/^(?:1[S5][C0]|I[S5]C|J[c5C]|J50|150|Ye)\b/i, ' ')
      .replace(/\b(?:Education\s*[1-5]|Class\s*(?:Eight|8)|8th\s*(?:Class|Pass))\b/gi, ' ')
      .replace(/\(?\s*Out\s+of\s*[45]\s*\)?/gi, ' ')
      .replace(/(?:^|\s)[45]\s*\)/g, ' ')
      .replace(/\b(?:GPA|CGPA)\s*[:\s]*[1-5]\.?\d{0,2}\b/gi, ' ')
      .replace(/\b[1-5]\.\d{1,2}\b/g, ' ')
      .replace(yearStr ? new RegExp(`\\b${yearStr}\\b`, 'g') : /$^/, ' ');
    if (rawYearMatch && rawYearMatch !== yearStr) {
      src = src.replace(new RegExp(`\\b${rawYearMatch}\\b`, 'g'), ' ');
    }
    const m = src.match(/\b(\d{4,8})\b/) || src.match(/\b(\d{2,8})\b/);
    return m ? m[1] : '';
  };

  const extractJscInstitute = (kvInst, jscScope) => {
    if (kvInst) return kvInst;
    // Strip GPA/Out-of-5 fragments first so "(Out of 5)" never prematurely closes the institute parenthesis
    const cleanInstScope = jscScope
      .replace(/\b(?:GPA|CGPA)\s*[:\s]*[1-5](?:\.\d{1,2}|\d{2})?(?:\s*\(?\s*Out\s+of(?:\s*\d+)?\s*\)?)?/gi, ' ')
      .replace(/\(?\s*Out\s+of\s*[45]\s*\)?/gi, ' ')
      .replace(/(?:^|\s)[45]\s*\)/g, ' ');
    const parenInstM =
      cleanInstScope.match(/(?:Rajshahi|Dhaka|Cumilla|Comilla|Chattogram|Chittagong|Jashore|Jessore|Barishal|Barisal|Sylhet|Dinajpur|Mymensingh|Madrasah|Technical|ajshahi|haka)\s*\(([^)]+)\)/i) ||
      cleanInstScope.match(/\(([^)]*(?:School|Madrasah|Academy|College|Institute|High)[^)]*)\)/i);
    if (parenInstM) {
      return parenInstM[1]
        .replace(/\b(?:GPA|CGPA|Passed|J\.?\s*[S5]\.?\s*C|Class\s*Eight)\b/gi, ' ')
        .replace(/\(?\s*Out\s+of(?:\s*\d+)?\b/gi, ' ')
        .replace(/\b\d+\.\d+\b/g, ' ')
        .replace(/\b\d{4,8}\b/g, ' ')
        .replace(/\s*N\/A\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const schM = cleanInstScope.match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z0-9][A-Za-z.'-]+){0,5}\s+(?:High\s+School|Girls'?\s+School|Boys'?\s+School|School|Madrasah|Academy|College|Institute))/i);
    if (schM) return schM[1].trim();
    // Handle clipped trailing school word without closing paren (e.g. "Rajshahi (AKKELPUR F.U. PILOT HIGH")
    const clippedParenM = cleanInstScope.match(/(?:Rajshahi|Dhaka|Cumilla|Comilla|Chattogram|Chittagong|Jashore|Jessore|Barishal|Barisal|Sylhet|Dinajpur|Mymensingh)\s*\(([A-Z][A-Za-z0-9.'\s-]{4,55}?)(?=\s+(?:\d{4,8}|N\/A|GPA|Passed)\b|$)/i);
    return clippedParenM ? clippedParenM[1].replace(/\b(?:\d{4,8}|N\/A)\b/gi, ' ').replace(/\s+/g, ' ').trim() : '';
  };

  const extractSscHscGroup = (kvGroup, scope, yearVal, rawYearMatch) => {
    if (kvGroup) return extractGroup(kvGroup, kvGroup) || kvGroup;
    const strippedScope = scope
      .replace(/\b(?:[SH]\.?\s*S\.?\s*C(?:\s*\(?\s*(?:Vocational|BM)\s*\)?)?|Vocational\s+Board|Bangladesh\s+Technical\s+Education\s+Board(?:\s*\(BTEB\))?)\b/gi, ' ');
    const specificGroup = extractGroup(strippedScope, '');
    if (specificGroup) return specificGroup;
    const colGroup = extractSubjectFromColumn(scope, yearVal) ||
      (rawYearMatch && rawYearMatch !== yearVal ? extractSubjectFromColumn(scope, rawYearMatch) : '');
    if (colGroup) return colGroup;
    return /\bVocational\b/i.test(scope) ? 'Vocational' : '';
  };

  const parseHigherEducationBlock = (blockLines, defaultExam, defaultDuration) => {
    const scope = blockLines.join(' ');
    const kvExam = getEduBlockVal(blockLines, /^Examination\b/i);
    const kvInst = getEduBlockVal(blockLines, /^(?:University\s*\/?\s*Institute|University|Institute(?:\s*Name)?)\b/i);
    const kvSub = getEduBlockVal(blockLines, /^(?:Subject\s*\/?\s*Major|Subject|Major)\b/i);
    const kvRes = getEduBlockVal(blockLines, /^(?:Result\s*\/?\s*(?:CGPA|GPA)|Result|CGPA|GPA)\b/i);
    const kvYear = getEduBlockVal(blockLines, /^(?:Passing\s*Year|Year)\b/i);
    const kvDur = getEduBlockVal(blockLines, /^Duration\b/i);

    const yearM = (kvYear || scope).match(/\b(19\d{2}|20\d{2})\b/);
    const resSrc = kvRes || scope;
    const cgpaM =
      resSrc.match(/(?:CGPA|GPA)\s*[:\s]*([1-5]\.\d{1,2})/i) ||
      resSrc.match(/\b([1-5]\.\d{1,2})\s*(?:\(\s*Out\s*of\s*[45]\s*\))?/i);
    const durM =
      (kvDur || scope).match(/\b0?([1-5])\s*Years?\b/i) ||
      (kvDur && kvDur.match(/^\s*0?([1-5])\s*$/)) ||
      (yearM && scope.slice(scope.indexOf(yearM[1]) + 4).match(/^\s*(0?[1-5])\b/));

    let resultType = '';
    let resultVal = '';
    if (cgpaM) {
      resultType = parseFloat(cgpaM[1]) > 4 || /Out\s*of\s*5/i.test(resSrc) ? 'GPA(out of 5)' : 'CGPA(out of 4)';
      resultVal = cgpaM[1];
    } else if (/1st\s*(?:Class|Division)/i.test(resSrc)) {
      resultType = '1st Class';
      resultVal = '1st Class';
    } else if (/2nd\s*(?:Class|Division)/i.test(resSrc)) {
      resultType = '2nd Class';
      resultVal = '2nd Class';
    } else if (/3rd\s*(?:Class|Division)/i.test(resSrc)) {
      resultType = '3rd Class';
      resultVal = '3rd Class';
    } else if (/\bPassed\b/i.test(resSrc)) {
      resultType = 'Passed';
      resultVal = 'Passed';
    }

    const examName = kvExam || defaultExam;
    let subject = kvSub || extractSubjectFromColumn(scope, yearM ? yearM[1] : '') || extractSubject(scope, examName);
    const institute = kvInst || extractInstitute(scope, '');
    const durNum = durM ? String(parseInt(durM[1], 10)) : '';
    const duration = durNum ? `${durNum} ${durNum === '1' ? 'Year' : 'Years'}` : defaultDuration;

    return {
      examination: examName,
      institute,
      subject,
      resultType,
      result: resultVal,
      passingYear: yearM ? yearM[1] : '',
      duration
    };
  };

  let inEduSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:Educational?\s*(?:Info|Qualification)|Academic\s*Qualification|Examination\s+Board|Board\/University)\b/i.test(line) || /\bExamination\b.*\bBoard\b/i.test(line)) {
      inEduSection = true;
    } else if (/^(?:Present\s*Address|Permanent\s*Address|Declaration|I\s+declare|Verification|Signature|Powered\s+by)/i.test(line)) {
      inEduSection = false;
    }

    let lineLevel = detectEduLevel(line);
    if (lineLevel) {
      inEduSection = true;
    } else if (inEduSection && i > lastConsumedEduLine && !isEduTableHeader(line) && !isEduFieldLabel(line) && !isKnownLabelLine(line)) {
      const nextLine = lines[i + 1] || '';
      const nextLineCtx = `${line} ${nextLine}`;
      const nextHasLevel = Boolean(detectEduLevel(nextLine));
      if (
        !profile.education.jsc &&
        !nextHasLevel &&
        /^(?:1[S5][C0]|I[S5]C|J[c5C]|J50|150|Ye)\b/i.test(line) &&
        (Boolean(matchBoard(nextLineCtx)) || /\b(?:GPA|Passed|\d{5,7}|20\d{2}|SCHOOL)\b/i.test(nextLineCtx))
      ) {
        lineLevel = 'jsc';
      } else if (
        !profile.education.jsc &&
        !profile.education.ssc &&
        !nextHasLevel &&
        Boolean(matchBoard(line)) &&
        /\b(?:\d{4,7}|19\d{2}|20\d{2})\b/.test(line) &&
        /\((?:[^)]*(?:HIGH|SCHOOL|ACADEMY|MADRASAH)|[A-Z.\s]{4,})\b/i.test(nextLineCtx) &&
        !/\b(?:Technical|BTEB|Vocational|Science|Humanities|Commerce|Business\s*Studies|S\.?\s*S\.?\s*C|H\.?\s*S\.?\s*C|Dakhil|Alim)\b/i.test(nextLineCtx)
      ) {
        lineLevel = 'jsc';
      } else if (/(?:১\.০\.|[S5]\.?[S5]\.?C\b)/i.test(line) && /\b(?:Vocational|Technical|BTEB|GPA|Science|Humanities|Commerce)\b/i.test(nextLineCtx)) {
        lineLevel = 'ssc';
      }
    }
    if (!lineLevel) continue;

    // 1. JSC / Class Eight
    if (lineLevel === 'jsc') {
      const { blockLines, endIdx } = collectEduBlock(i, 'jsc');
      const jscScope = blockLines.join(' ');
      const kvExam = getEduBlockVal(blockLines, /^Examination\b/i);
      const kvBoard = getEduBlockVal(blockLines, /^Board\b/i);
      const kvRoll = getEduBlockVal(blockLines, /^Roll(?:\s*No)?\b/i);
      const kvInst = getEduBlockVal(blockLines, /^(?:School\s*\/?\s*Institute|School|Institute(?:\s*Name)?)\b/i);
      const kvResult = getEduBlockVal(blockLines, /^(?:Result\s*\/?\s*(?:GPA|CGPA)|Result|GPA)\b/i);
      const kvYear = getEduBlockVal(blockLines, /^(?:Passing\s*Year|Year)\b/i);

      const { year: passingYear, rawMatch: rawYearMatch } = extractEduYear(kvYear, jscScope);
      const gpaVal = extractGpa(kvResult || jscScope);
      const roll = extractCleanRoll(kvRoll, jscScope, passingYear, rawYearMatch);
      const board = matchBoard(kvBoard || jscScope) || kvBoard.trim();
      const institute = extractJscInstitute(kvInst, jscScope);

      const isPassed = /\bPassed\b/i.test(kvResult || jscScope) && !gpaVal;
      const candidateJsc = {
        examination: kvExam || (/J\.?\s*D\.?\s*C/i.test(jscScope) ? 'JDC' : (/Class\s*(?:Eight|8)|8th\s*(?:Class|Pass)/i.test(jscScope) ? 'Class Eight' : 'JSC')),
        board,
        roll,
        institute,
        resultType: gpaVal ? 'GPA(out of 5)' : 'Passed',
        result: gpaVal || 'Passed',
        passingYear
      };
      mergeEduSlot('jsc', candidateJsc, Boolean(candidateJsc.board || candidateJsc.roll || candidateJsc.institute || gpaVal || candidateJsc.passingYear), endIdx);
    }

    // 2. SSC / Dakhil
    if (lineLevel === 'ssc') {
      const { blockLines, endIdx } = collectEduBlock(i, 'ssc');
      const sscScope = blockLines.join(' ');
      const kvExam = getEduBlockVal(blockLines, /^Examination\b/i);
      const kvBoard = getEduBlockVal(blockLines, /^Board\b/i);
      const kvRoll = getEduBlockVal(blockLines, /^Roll(?:\s*No)?\b/i);
      const kvGroup = getEduBlockVal(blockLines, /^(?:Group|Subject)\b/i);
      const kvResult = getEduBlockVal(blockLines, /^(?:Result\s*\/?\s*(?:GPA|CGPA)|Result|GPA)\b/i);
      const kvYear = getEduBlockVal(blockLines, /^(?:Passing\s*Year|Year)\b/i);

      const { year: passingYear, rawMatch: rawYearMatch } = extractEduYear(kvYear, sscScope);
      const roll = extractCleanRoll(kvRoll, sscScope, passingYear, rawYearMatch);
      const gpaVal = extractGpa(kvResult || sscScope);
      const divM = (kvResult || sscScope).match(/\b(1st|2nd|3rd)\s*(?:Division|Class)\b/i);
      const group = extractSscHscGroup(kvGroup, sscScope, passingYear, rawYearMatch);

      const candidateSsc = {
        examination: kvExam || (/Dakhil/i.test(sscScope) ? 'Dakhil' : (/Vocational/i.test(sscScope) ? 'S.S.C Vocational' : 'S.S.C')),
        board: matchBoard(kvBoard || sscScope) || kvBoard.trim(),
        roll,
        group,
        resultType: gpaVal ? 'GPA(out of 5)' : (divM ? `${divM[1]} Division` : ''),
        result: gpaVal || (divM ? `${divM[1]} Division` : ''),
        passingYear
      };
      mergeEduSlot('ssc', candidateSsc, Boolean(candidateSsc.board || candidateSsc.roll || candidateSsc.group || candidateSsc.result || candidateSsc.passingYear), endIdx);
    }

    // 3. HSC / Alim / Diploma
    if (lineLevel === 'hsc') {
      const { blockLines, endIdx } = collectEduBlock(i, 'hsc');
      const hscScope = blockLines.join(' ');
      const kvExam = getEduBlockVal(blockLines, /^Examination\b/i);
      const kvBoard = getEduBlockVal(blockLines, /^Board\b/i);
      const kvRoll = getEduBlockVal(blockLines, /^Roll(?:\s*No)?\b/i);
      const kvGroup = getEduBlockVal(blockLines, /^(?:Group|Subject)\b/i);
      const kvResult = getEduBlockVal(blockLines, /^(?:Result\s*\/?\s*(?:GPA|CGPA)|Result|GPA)\b/i);
      const kvYear = getEduBlockVal(blockLines, /^(?:Passing\s*Year|Year)\b/i);

      const { year: passingYear, rawMatch: rawYearMatch } = extractEduYear(kvYear, hscScope);
      const roll = extractCleanRoll(kvRoll, hscScope, passingYear, rawYearMatch);
      const gpaVal = extractGpa(kvResult || hscScope);
      const divM = (kvResult || hscScope).match(/\b(1st|2nd|3rd)\s*(?:Division|Class)\b/i);
      let examName = kvExam || 'H.S.C';
      if (!kvExam) {
        if (/Alim/i.test(hscScope)) examName = 'Alim';
        else if (/Diploma/i.test(hscScope)) examName = 'Diploma in Engineering';
        else if (/Vocational/i.test(hscScope)) examName = 'H.S.C Vocational';
        else if (/\bB\.?\s*M\b/i.test(hscScope)) examName = 'H.S.C (BM)';
      }
      const group = extractSscHscGroup(kvGroup, hscScope, passingYear, rawYearMatch);

      const candidateHsc = {
        examination: examName,
        board: matchBoard(kvBoard || hscScope) || (/Diploma/i.test(examName) ? 'Technical' : kvBoard.trim()),
        roll,
        group,
        resultType: gpaVal ? 'GPA(out of 5)' : (divM ? `${divM[1]} Division` : ''),
        result: gpaVal || (divM ? `${divM[1]} Division` : ''),
        passingYear
      };
      mergeEduSlot('hsc', candidateHsc, Boolean(candidateHsc.board || candidateHsc.roll || candidateHsc.group || candidateHsc.result || candidateHsc.passingYear), endIdx);
    }

    // 4. Graduation / Fazil / Honours / Bachelor
    if (lineLevel === 'graduation') {
      const { blockLines, endIdx } = collectEduBlock(i, 'graduation');
      const gradScope = blockLines.join(' ');
      let examName = 'Graduation';
      let defaultDur = '4 Years';
      if (/\b(?:Fazil|Fajil)\b/i.test(gradScope)) {
        examName = 'Fazil';
        defaultDur = /Honou?rs/i.test(gradScope) ? '4 Years' : '3 Years';
      } else if (/\bHonou?rs\b/i.test(gradScope)) {
        const degM = gradScope.match(/\b(B\.?\s*S\.?\s*C|B\.?\s*A|B\.?\s*Com|B\.?\s*S\.?\s*S|B\.?\s*B\.?\s*A)\b/i);
        examName = degM ? `${degM[1].replace(/\s+/g, '')} (Honours)` : 'Honours';
      } else {
        const examM = gradScope.match(/\b(B\.?\s*S\.?\s*C(?:\s*Engg\.?|\s*Engineering)?|B\.?\s*A|B\.?\s*Com|B\.?\s*S\.?\s*S|B\.?\s*B\.?\s*A|M\.?\s*B\.?\s*B\.?\s*S|LL\.?\s*B|B\.?\s*Ed|Graduation|Bachelor|Degree(?:\s*\(?Pass\)?)?)\b/i);
        if (examM) examName = examM[1].replace(/\s+/g, ' ').trim();
      }
      const candidateGrad = parseHigherEducationBlock(blockLines, examName, defaultDur);
      mergeEduSlot('graduation', candidateGrad, Boolean(candidateGrad.institute || candidateGrad.subject || candidateGrad.result || candidateGrad.passingYear), endIdx);
    }

    // 5. Masters / Kamil / Equivalent
    if (lineLevel === 'masters') {
      const { blockLines, endIdx } = collectEduBlock(i, 'masters');
      const masScope = blockLines.join(' ');
      let examName = 'Masters';
      if (/\bKamil\b/i.test(masScope)) {
        examName = 'Kamil';
      } else {
        const examM = masScope.match(/\b(M\.?\s*S\.?\s*C|M\.?\s*A|M\.?\s*Com|M\.?\s*S\.?\s*S|M\.?\s*B\.?\s*A|LL\.?\s*M|M\.?\s*Ed|Master(?:'s|s)?)\b/i);
        if (examM) examName = examM[1].replace(/\s+/g, '');
      }
      const candidateMasters = parseHigherEducationBlock(blockLines, examName, '1 Year');
      mergeEduSlot('masters', candidateMasters, Boolean(candidateMasters.institute || candidateMasters.subject || candidateMasters.result || candidateMasters.passingYear), endIdx);
    }
  }

  return profile;
}

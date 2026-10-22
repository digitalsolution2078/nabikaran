-- 0029: Nepal coverage. Eight more renewal types Nepalis actually renew, and a
-- short "where to go / what to bring / fees and fines" note per template,
-- shown on the record page and the SEO page. Additive, re-runnable.

alter table document_templates add column if not exists info_en text not null default '';
alter table document_templates add column if not exists info_ne text not null default '';

insert into document_templates (slug, group_key, category, name_en, name_ne, sms_label, description_en, description_ne, default_offsets, popular, sort_order) values
  ('ward-business-registration','business','business_registration','Ward Business Registration','वडा व्यवसाय दर्ता','Business Reg.',
   'Enter the renewal date on your ward (municipality) business registration certificate. Confirm the renewal month and fee with your ward office.',
   'वडा (नगरपालिका) व्यवसाय दर्ता प्रमाणपत्रमा भएको नवीकरण मिति राख्नुहोस्। नवीकरण महिना र शुल्क वडा कार्यालयमा पुष्टि गर्नुहोस्।',
   '{43200,10080,1440,0}', true, 60),
  ('trade-licence','business','trade_licence','Trade / Firm Licence','व्यवसाय / फर्म इजाजत','Trade Licence',
   'Enter the expiry date printed on your trade or firm licence. Renewal rules differ by office; confirm with the issuing office.',
   'व्यवसाय वा फर्म इजाजतपत्रमा छापिएको म्याद राख्नुहोस्। नवीकरणका नियम कार्यालयअनुसार फरक हुन्छन्; जारी गर्ने कार्यालयमा पुष्टि गर्नुहोस्।',
   '{43200,10080,1440,0}', false, 62),
  ('pollution-check','vehicle','pollution_check','Vehicle Pollution Check (Green Sticker)','सवारी प्रदूषण जाँच (ग्रीन स्टिकर)','Pollution Check',
   'Enter the expiry date on your pollution check sticker or slip. Confirm the test period and fee with the testing centre or your transport office.',
   'प्रदूषण जाँच स्टिकर वा पुर्जामा भएको म्याद राख्नुहोस्। जाँच अवधि र शुल्क परीक्षण केन्द्र वा यातायात कार्यालयमा पुष्टि गर्नुहोस्।',
   '{10080,1440,0}', true, 35),
  ('electricity-bill','personal','utility_bill','Electricity (NEA) Bill','बिजुली (NEA) बिल','Bill',
   'Enter the due date from your electricity bill. The due date and late fee are set by NEA; confirm on your bill or the NEA app.',
   'बिजुली बिलमा भएको तिर्नुपर्ने मिति राख्नुहोस्। मिति र ढिलो शुल्क NEA ले तोक्छ; बिल वा NEA एपमा पुष्टि गर्नुहोस्।',
   '{4320,1440,0}', false, 130),
  ('water-bill','personal','utility_bill','Water (KUKL / Khanepani) Bill','पानी (खानेपानी) बिल','Bill',
   'Enter the due date from your water bill. Confirm the due date and any late fee with your water supply office.',
   'पानी बिलमा भएको तिर्नुपर्ने मिति राख्नुहोस्। मिति र ढिलो शुल्क खानेपानी कार्यालयमा पुष्टि गर्नुहोस्।',
   '{4320,1440,0}', false, 132),
  ('sim-validity','personal','sim_validity','SIM Validity / Data Pack','SIM भ्यालिडिटी / डाटा प्याक','SIM',
   'Enter the validity end date shown in your NTC or Ncell app so a prepaid SIM or data pack is not cut off. Confirm the exact date with your operator.',
   'NTC वा Ncell एपमा देखिने भ्यालिडिटी सकिने मिति राख्नुहोस्, ताकि प्रिपेड SIM वा डाटा प्याक नकाटियोस्। सही मिति अपरेटरसँग पुष्टि गर्नुहोस्।',
   '{4320,1440,0}', false, 134),
  ('bank-kyc','personal','bank_kyc','Bank KYC Update','बैंक KYC अद्यावधिक','Bank KYC',
   'Enter the date your bank asked you to update KYC by (from the bank''s SMS or letter). Accounts can be restricted after it; confirm with your bank.',
   'बैंकले KYC अद्यावधिक गर्न भनेको अन्तिम मिति (बैंकको SMS वा पत्रबाट) राख्नुहोस्। त्यसपछि खाता रोकिन सक्छ; बैंकमा पुष्टि गर्नुहोस्।',
   '{43200,10080,1440,0}', false, 136),
  ('ssf-contribution','business','ssf','SSF Contribution','सामाजिक सुरक्षा कोष योगदान','SSF',
   'Enter the monthly contribution due date for the Social Security Fund from your SSF portal. Confirm the deadline and penalty rules with SSF.',
   'सामाजिक सुरक्षा कोषको मासिक योगदान तिर्ने मिति SSF पोर्टलबाट राख्नुहोस्। अन्तिम मिति र जरिवाना नियम SSF मा पुष्टि गर्नुहोस्।',
   '{4320,1440,0}', false, 70)
on conflict (slug) do nothing;

-- Office / documents / fee notes for the most used templates (owner can edit in Admin → Templates).
update document_templates set
  info_en = 'Where: your province Transport Management Office (Yatayat) or its service centre. Bring: bluebook, citizenship or licence copy, insurance paper, last tax receipt; the vehicle may be checked. Fees: yearly tax depends on engine size and province; a pollution check and third-party insurance are usually needed first. Late: after about 90 days fines are added and grow by year. Confirm the current rules at the office.',
  info_ne = 'कहाँ: प्रदेशको यातायात व्यवस्था कार्यालय वा सेवा केन्द्र। लैजाने: ब्लुबुक, नागरिकता वा लाइसेन्सको प्रतिलिपि, बीमा कागज, अघिल्लो करको रसिद; सवारी जाँच हुन सक्छ। शुल्क: वार्षिक कर इन्जिन क्षमता र प्रदेशअनुसार; पहिले प्रदूषण जाँच र तेस्रो पक्ष बीमा चाहिन्छ। ढिलो: करिब ९० दिनपछि जरिवाना लाग्छ र वर्षैपिच्छे बढ्छ। कार्यालयमा हालको नियम पुष्टि गर्नुहोस्।'
  where slug in ('bluebook','vehicle-tax') and info_en = '';
update document_templates set
  info_en = 'Where: Transport Management Office (smart licence counter) or online pre-application on the DoTM portal. Bring: old licence, citizenship copy, photos; a medical form may be asked. Late renewal is allowed with fines that grow by year; after several years a re-test may be required. Confirm with the office.',
  info_ne = 'कहाँ: यातायात व्यवस्था कार्यालय (स्मार्ट लाइसेन्स काउन्टर) वा DoTM पोर्टलबाट अनलाइन पूर्व-आवेदन। लैजाने: पुरानो लाइसेन्स, नागरिकताको प्रतिलिपि, फोटो; मेडिकल फारम माग्न सक्छ। ढिलो नवीकरणमा वर्षअनुसार जरिवाना लाग्छ; धेरै वर्ष ढिलो भए पुनः परीक्षा चाहिन सक्छ। कार्यालयमा पुष्टि गर्नुहोस्।'
  where slug = 'driving-licence' and info_en = '';
update document_templates set
  info_en = 'Where: your insurer''s branch, agent or app. Bring: old policy, bluebook copy. Third-party cover is compulsory to drive and to pay vehicle tax; do not let it lapse even for a day. Comprehensive cover is optional. Compare premiums before renewing.',
  info_ne = 'कहाँ: बीमा कम्पनीको शाखा, एजेन्ट वा एप। लैजाने: पुरानो पोलिसी, ब्लुबुकको प्रतिलिपि। तेस्रो पक्ष बीमा चलाउन र कर तिर्न अनिवार्य छ; एक दिन पनि टुट्न नदिनुहोस्। कम्प्रिहेन्सिभ ऐच्छिक हो। नवीकरणअघि प्रिमियम तुलना गर्नुहोस्।'
  where slug = 'vehicle-insurance' and info_en = '';
update document_templates set
  info_en = 'Where: Department of Passports (Kathmandu) or your District Administration Office; apply online first on the e-passport portal. Bring: old passport, citizenship, photos as per the portal. Many countries need 6 months of validity for a visa, so renew early. Confirm fees and timing on the portal.',
  info_ne = 'कहाँ: राहदानी विभाग (काठमाडौं) वा जिल्ला प्रशासन कार्यालय; पहिले ई-पासपोर्ट पोर्टलमा अनलाइन आवेदन। लैजाने: पुरानो राहदानी, नागरिकता, पोर्टलअनुसारका फोटो। धेरै देशको भिसाका लागि ६ महिना म्याद चाहिन्छ, त्यसैले चाँडै नवीकरण गर्नुहोस्। शुल्क र समय पोर्टलमा पुष्टि गर्नुहोस्।'
  where slug = 'passport' and info_en = '';
update document_templates set
  info_en = 'Where: your ward office (municipality). Bring: last year''s certificate, PAN/registration copy, citizenship copy, a passport photo; some wards want a rent agreement or tax clearance. Fees depend on business type and ward; late renewal usually adds a fine. Confirm with the ward.',
  info_ne = 'कहाँ: वडा कार्यालय (नगरपालिका)। लैजाने: गत वर्षको प्रमाणपत्र, PAN/दर्ताको प्रतिलिपि, नागरिकताको प्रतिलिपि, पासपोर्ट साइज फोटो; कुनै वडामा भाडा सम्झौता वा कर चुक्ता चाहिन्छ। शुल्क व्यवसायको प्रकार र वडाअनुसार; ढिलो गर्दा जरिवाना लाग्छ। वडामा पुष्टि गर्नुहोस्।'
  where slug = 'ward-business-registration' and info_en = '';
update document_templates set
  info_en = 'Where: an authorised pollution testing centre (many petrol pumps and workshops). Bring: the vehicle, bluebook. The test takes minutes; keep the sticker and slip, both are asked for at tax time and by traffic police.',
  info_ne = 'कहाँ: स्वीकृत प्रदूषण परीक्षण केन्द्र (धेरै पेट्रोल पम्प र वर्कशप)। लैजाने: सवारी, ब्लुबुक। जाँच केही मिनेटमा हुन्छ; स्टिकर र पुर्जा राख्नुहोस्, कर तिर्दा र ट्राफिक प्रहरीले माग्छन्।'
  where slug = 'pollution-check' and info_en = '';

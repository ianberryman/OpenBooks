const { DataSource } = require('apollo-datasource');
const NotFoundError = require('../errors/NotFoundError');

// usd list
const rates = [
    {
        "currency": "AED",
        "name": "United Arab Emirates Dirham",
        "rate": "3.6732"
    },
    {
        "currency": "AFN",
        "name": "Afghan Afghani",
        "rate": "77.599998"
    },
    {
        "currency": "ALL",
        "name": "Albanian Lek",
        "rate": "102.4"
    },
    {
        "currency": "AMD",
        "name": "Armenian Dram",
        "rate": "522.347726"
    },
    {
        "currency": "ANG",
        "name": "Netherlands Antillean Gulden",
        "rate": "1.795429"
    },
    {
        "currency": "AOA",
        "name": "Angolan Kwanza",
        "rate": "656.414"
    },
    {
        "currency": "ARS",
        "name": "Argentine Peso",
        "rate": "93.133845"
    },
    {
        "currency": "AUD",
        "name": "Australian Dollar",
        "rate": "1.290156"
    },
    {
        "currency": "AWG",
        "name": "Aruban Florin",
        "rate": "1.8005"
    },
    {
        "currency": "AZN",
        "name": "Azerbaijani Manat",
        "rate": "1.700805"
    },
    {
        "currency": "BAM",
        "name": "Bosnia and Herzegovina Convertible Mark",
        "rate": "1.628555"
    },
    {
        "currency": "BBD",
        "name": "Barbadian Dollar",
        "rate": "2"
    },
    {
        "currency": "BDT",
        "name": "Bangladeshi Taka",
        "rate": "84.771759"
    },
    {
        "currency": "BGN",
        "name": "Bulgarian Lev",
        "rate": "1.619035"
    },
    {
        "currency": "BHD",
        "name": "Bahraini Dinar",
        "rate": "0.376937"
    },
    {
        "currency": "BIF",
        "name": "Burundian Franc",
        "rate": "1968"
    },
    {
        "currency": "BMD",
        "name": "Bermudian Dollar",
        "rate": "1"
    },
    {
        "currency": "BND",
        "name": "Brunei Dollar",
        "rate": "1.327495"
    },
    {
        "currency": "BOB",
        "name": "Bolivian Boliviano",
        "rate": "6.906632"
    },
    {
        "currency": "BRL",
        "name": "Brazilian Real",
        "rate": "5.4831"
    },
    {
        "currency": "BSD",
        "name": "Bahamian Dollar",
        "rate": "1"
    },
    {
        "currency": "BTN",
        "name": "Bhutanese Ngultrum",
        "rate": "74.901732"
    },
    {
        "currency": "BWP",
        "name": "Botswana Pula",
        "rate": "10.807582"
    },
    {
        "currency": "BYN",
        "name": "Belarusian Ruble",
        "rate": "2.589265"
    },
    {
        "currency": "BYR",
        "name": "Belarusian Ruble",
        "rate": "25892.65"
    },
    {
        "currency": "BZD",
        "name": "Belize Dollar",
        "rate": "2.016176"
    },
    {
        "currency": "CAD",
        "name": "Canadian Dollar",
        "rate": "1.247606"
    },
    {
        "currency": "CDF",
        "name": "Congolese Franc",
        "rate": "1997"
    },
    {
        "currency": "CHF",
        "name": "Swiss Franc",
        "rate": "0.91361"
    },
    {
        "currency": "CLF",
        "name": "Unidad de Fomento",
        "rate": "0.025854"
    },
    {
        "currency": "CLP",
        "name": "Chilean Peso",
        "rate": "713.401071"
    },
    {
        "currency": "CNY",
        "name": "Chinese Renminbi Yuan",
        "rate": "6.4954"
    },
    {
        "currency": "COP",
        "name": "Colombian Peso",
        "rate": "3623.923087"
    },
    {
        "currency": "CRC",
        "name": "Costa Rican Colón",
        "rate": "614.633897"
    },
    {
        "currency": "CUC",
        "name": "Cuban Convertible Peso",
        "rate": "1"
    },
    {
        "currency": "CVE",
        "name": "Cape Verdean Escudo",
        "rate": "91.8"
    },
    {
        "currency": "CZK",
        "name": "Czech Koruna",
        "rate": "21.349"
    },
    {
        "currency": "DJF",
        "name": "Djiboutian Franc",
        "rate": "178.066293"
    },
    {
        "currency": "DKK",
        "name": "Danish Krone",
        "rate": "6.147405"
    },
    {
        "currency": "DOP",
        "name": "Dominican Peso",
        "rate": "56.9"
    },
    {
        "currency": "DZD",
        "name": "Algerian Dinar",
        "rate": "132.752463"
    },
    {
        "currency": "EGP",
        "name": "Egyptian Pound",
        "rate": "15.7001"
    },
    {
        "currency": "ERN",
        "name": "Eritrean Nakfa",
        "rate": "15.00197"
    },
    {
        "currency": "ETB",
        "name": "Ethiopian Birr",
        "rate": "41.8"
    },
    {
        "currency": "EUR",
        "name": "Euro",
        "rate": "0.826709"
    },
    {
        "currency": "FJD",
        "name": "Fijian Dollar",
        "rate": "2.0384"
    },
    {
        "currency": "FKP",
        "name": "Falkland Pound",
        "rate": "0.720351"
    },
    {
        "currency": "GBP",
        "name": "British Pound",
        "rate": "0.720351"
    },
    {
        "currency": "GEL",
        "name": "Georgian Lari",
        "rate": "3.45"
    },
    {
        "currency": "GHS",
        "name": "Ghanaian Cedi",
        "rate": "5.78"
    },
    {
        "currency": "GIP",
        "name": "Gibraltar Pound",
        "rate": "0.720351"
    },
    {
        "currency": "GMD",
        "name": "Gambian Dalasi",
        "rate": "51.11"
    },
    {
        "currency": "GNF",
        "name": "Guinean Franc",
        "rate": "9930"
    },
    {
        "currency": "GTQ",
        "name": "Guatemalan Quetzal",
        "rate": "7.718362"
    },
    {
        "currency": "GYD",
        "name": "Guyanese Dollar",
        "rate": "209.18322"
    },
    {
        "currency": "HKD",
        "name": "Hong Kong Dollar",
        "rate": "7.75945"
    },
    {
        "currency": "HNL",
        "name": "Honduran Lempira",
        "rate": "24.134999"
    },
    {
        "currency": "HRK",
        "name": "Croatian Kuna",
        "rate": "6.2567"
    },
    {
        "currency": "HTG",
        "name": "Haitian Gourde",
        "rate": "83.700385"
    },
    {
        "currency": "HUF",
        "name": "Hungarian Forint",
        "rate": "300.37"
    },
    {
        "currency": "IDR",
        "name": "Indonesian Rupiah",
        "rate": "14514.85"
    },
    {
        "currency": "ILS",
        "name": "Israeli New Sheqel",
        "rate": "3.25815"
    },
    {
        "currency": "INR",
        "name": "Indian Rupee",
        "rate": "74.868361"
    },
    {
        "currency": "IQD",
        "name": "Iraqi Dinar",
        "rate": "1462.5"
    },
    {
        "currency": "ISK",
        "name": "Icelandic Króna",
        "rate": "125"
    },
    {
        "currency": "JMD",
        "name": "Jamaican Dollar",
        "rate": "151.01734"
    },
    {
        "currency": "JOD",
        "name": "Jordanian Dinar",
        "rate": "0.709"
    },
    {
        "currency": "JPY",
        "name": "Japanese Yen",
        "rate": "107.8895"
    },
    {
        "currency": "KES",
        "name": "Kenyan Shilling",
        "rate": "108.5"
    },
    {
        "currency": "KGS",
        "name": "Kyrgyzstani Som",
        "rate": "84.800677"
    },
    {
        "currency": "KHR",
        "name": "Cambodian Riel",
        "rate": "4053"
    },
    {
        "currency": "KMF",
        "name": "Comorian Franc",
        "rate": "408.350166"
    },
    {
        "currency": "KRW",
        "name": "South Korean Won",
        "rate": "1115.691273"
    },
    {
        "currency": "KWD",
        "name": "Kuwaiti Dinar",
        "rate": "0.301071"
    },
    {
        "currency": "KYD",
        "name": "Cayman Islands Dollar",
        "rate": "0.833548"
    },
    {
        "currency": "KZT",
        "name": "Kazakhstani Tenge",
        "rate": "430.492317"
    },
    {
        "currency": "LAK",
        "name": "Lao Kip",
        "rate": "9420"
    },
    {
        "currency": "LBP",
        "name": "Lebanese Pound",
        "rate": "1519.192852"
    },
    {
        "currency": "LKR",
        "name": "Sri Lankan Rupee",
        "rate": "194.545965"
    },
    {
        "currency": "LRD",
        "name": "Liberian Dollar",
        "rate": "172.450048"
    },
    {
        "currency": "LSL",
        "name": "Lesotho Loti",
        "rate": "14.3"
    },
    {
        "currency": "LYD",
        "name": "Libyan Dinar",
        "rate": "4.48"
    },
    {
        "currency": "MAD",
        "name": "Moroccan Dirham",
        "rate": "8.8985"
    },
    {
        "currency": "MDL",
        "name": "Moldovan Leu",
        "rate": "17.88118"
    },
    {
        "currency": "MGA",
        "name": "Malagasy Ariary",
        "rate": "3765"
    },
    {
        "currency": "MKD",
        "name": "Macedonian Denar",
        "rate": "51.273624"
    },
    {
        "currency": "MMK",
        "name": "Myanmar Kyat",
        "rate": "1409.612055"
    },
    {
        "currency": "MNT",
        "name": "Mongolian Tögrög",
        "rate": "2850.826192"
    },
    {
        "currency": "MOP",
        "name": "Macanese Pataca",
        "rate": "7.997014"
    },
    {
        "currency": "MRO",
        "name": "Mauritanian Ouguiya",
        "rate": "356.999828"
    },
    {
        "currency": "MUR",
        "name": "Mauritian Rupee",
        "rate": "40.396777"
    },
    {
        "currency": "MVR",
        "name": "Maldivian Rufiyaa",
        "rate": "15.45"
    },
    {
        "currency": "MWK",
        "name": "Malawian Kwacha",
        "rate": "789.628014"
    },
    {
        "currency": "MXN",
        "name": "Mexican Peso",
        "rate": "19.83615"
    },
    {
        "currency": "MYR",
        "name": "Malaysian Ringgit",
        "rate": "4.1095"
    },
    {
        "currency": "MZN",
        "name": "Mozambican Metical",
        "rate": "55.649997"
    },
    {
        "currency": "NAD",
        "name": "Namibian Dollar",
        "rate": "14.3"
    },
    {
        "currency": "NGN",
        "name": "Nigerian Naira",
        "rate": "381"
    },
    {
        "currency": "NIO",
        "name": "Nicaraguan Córdoba",
        "rate": "35.1475"
    },
    {
        "currency": "NOK",
        "name": "Norwegian Krone",
        "rate": "8.2947"
    },
    {
        "currency": "NPR",
        "name": "Nepalese Rupee",
        "rate": "119.842376"
    },
    {
        "currency": "NZD",
        "name": "New Zealand Dollar",
        "rate": "1.389447"
    },
    {
        "currency": "OMR",
        "name": "Omani Rial",
        "rate": "0.385011"
    },
    {
        "currency": "PAB",
        "name": "Panamanian Balboa",
        "rate": "1"
    },
    {
        "currency": "PEN",
        "name": "Peruvian Sol",
        "rate": "3.710033"
    },
    {
        "currency": "PGK",
        "name": "Papua New Guinean Kina",
        "rate": "3.53"
    },
    {
        "currency": "PHP",
        "name": "Philippine Peso",
        "rate": "48.242257"
    },
    {
        "currency": "PKR",
        "name": "Pakistani Rupee",
        "rate": "153.45"
    },
    {
        "currency": "PLN",
        "name": "Polish Złoty",
        "rate": "3.76495"
    },
    {
        "currency": "PYG",
        "name": "Paraguayan Guaraní",
        "rate": "6465.070393"
    },
    {
        "currency": "QAR",
        "name": "Qatari Riyal",
        "rate": "3.64075"
    },
    {
        "currency": "RON",
        "name": "Romanian Leu",
        "rate": "4.0691"
    },
    {
        "currency": "RSD",
        "name": "Serbian Dinar",
        "rate": "97.510056"
    },
    {
        "currency": "RUB",
        "name": "Russian Ruble",
        "rate": "74.9786"
    },
    {
        "currency": "RWF",
        "name": "Rwandan Franc",
        "rate": "985"
    },
    {
        "currency": "SAR",
        "name": "Saudi Riyal",
        "rate": "3.750295"
    },
    {
        "currency": "SBD",
        "name": "Solomon Islands Dollar",
        "rate": "7.980892"
    },
    {
        "currency": "SCR",
        "name": "Seychellois Rupee",
        "rate": "13.92021"
    },
    {
        "currency": "SEK",
        "name": "Swedish Krona",
        "rate": "8.386885"
    },
    {
        "currency": "SHP",
        "name": "Saint Helenian Pound",
        "rate": "0.720351"
    },
    {
        "currency": "SLL",
        "name": "Sierra Leonean Leone",
        "rate": "10208.750313"
    },
    {
        "currency": "SOS",
        "name": "Somali Shilling",
        "rate": "584.5"
    },
    {
        "currency": "SRD",
        "name": "Surinamese Dollar",
        "rate": "14.154"
    },
    {
        "currency": "SSP",
        "name": "South Sudanese Pound",
        "rate": "130.26"
    },
    {
        "currency": "STD",
        "name": "São Tomé and Príncipe Dobra",
        "rate": "20738.069016"
    },
    {
        "currency": "SVC",
        "name": "Salvadoran Colón",
        "rate": "8.752748"
    },
    {
        "currency": "SZL",
        "name": "Swazi Lilangeni",
        "rate": "14.279398"
    },
    {
        "currency": "THB",
        "name": "Thai Baht",
        "rate": "31.39"
    },
    {
        "currency": "TJS",
        "name": "Tajikistani Somoni",
        "rate": "11.404704"
    },
    {
        "currency": "TMT",
        "name": "Turkmenistani Manat",
        "rate": "3.5"
    },
    {
        "currency": "TND",
        "name": "Tunisian Dinar",
        "rate": "2.7425"
    },
    {
        "currency": "TOP",
        "name": "Tongan Paʻanga",
        "rate": "2.268422"
    },
    {
        "currency": "TRY",
        "name": "Turkish Lira",
        "rate": "8.378248"
    },
    {
        "currency": "TTD",
        "name": "Trinidad and Tobago Dollar",
        "rate": "6.793065"
    },
    {
        "currency": "TWD",
        "name": "New Taiwan Dollar",
        "rate": "28.046202"
    },
    {
        "currency": "TZS",
        "name": "Tanzanian Shilling",
        "rate": "2319"
    },
    {
        "currency": "UAH",
        "name": "Ukrainian Hryvnia",
        "rate": "28.044385"
    },
    {
        "currency": "UGX",
        "name": "Ugandan Shilling",
        "rate": "3612.044035"
    },
    {
        "currency": "UYU",
        "name": "Uruguayan Peso",
        "rate": "44.097506"
    },
    {
        "currency": "UZS",
        "name": "Uzbekistan Som",
        "rate": "10520"
    },
    {
        "currency": "VES",
        "name": "Venezuelan Bolívar Soberano",
        "rate": "2503219.5"
    },
    {
        "currency": "VND",
        "name": "Vietnamese Đồng",
        "rate": "22995.896637"
    },
    {
        "currency": "VUV",
        "name": "Vanuatu Vatu",
        "rate": "109.544432"
    },
    {
        "currency": "WST",
        "name": "Samoan Tala",
        "rate": "2.531864"
    },
    {
        "currency": "XAF",
        "name": "Central African Cfa Franc",
        "rate": "542.285773"
    },
    {
        "currency": "XAG",
        "name": "Silver (Troy Ounce)",
        "rate": "0.03841352"
    },
    {
        "currency": "XAU",
        "name": "Gold (Troy Ounce)",
        "rate": "0.00056274"
    },
    {
        "currency": "XCD",
        "name": "East Caribbean Dollar",
        "rate": "2.70255"
    },
    {
        "currency": "XDR",
        "name": "Special Drawing Rights",
        "rate": "0.697092"
    },
    {
        "currency": "XOF",
        "name": "West African Cfa Franc",
        "rate": "542.285773"
    },
    {
        "currency": "XPD",
        "name": "Palladium",
        "rate": "0.00034996"
    },
    {
        "currency": "XPF",
        "name": "Cfp Franc",
        "rate": "98.652665"
    },
    {
        "currency": "XPT",
        "name": "Platinum",
        "rate": "0.00081285"
    },
    {
        "currency": "YER",
        "name": "Yemeni Rial",
        "rate": "250.400036"
    },
    {
        "currency": "ZAR",
        "name": "South African Rand",
        "rate": "14.27375"
    },
    {
        "currency": "ZMW",
        "name": "Zambian Kwacha",
        "rate": "22.24578"
    },
    {
        "currency": "JEP",
        "name": "Jersey Pound",
        "rate": "0.720351"
    },
    {
        "currency": "GGP",
        "name": "Guernsey Pound",
        "rate": "0.720351"
    },
    {
        "currency": "IMP",
        "name": "Isle of Man Pound",
        "rate": "0.720351"
    },
    {
        "currency": "GBX",
        "name": "British Penny",
        "rate": "11.684129376962495"
    },
    {
        "currency": "CNH",
        "name": "Chinese Renminbi Yuan Offshore",
        "rate": "6.48898"
    },
    {
        "currency": "MTL",
        "name": "Maltese Lira",
        "rate": "0.30590410898536236"
    },
    {
        "currency": "ZWL",
        "name": "Zimbabwean Dollar",
        "rate": "322"
    },
    {
        "currency": "SGD",
        "name": "Singapore Dollar",
        "rate": "1.3267"
    },
    {
        "currency": "USD",
        "name": "US Dollar",
        "rate": "1.0"
    },
    {
        "currency": "BTC",
        "name": null,
        "rate": "1.959410997135439e-05"
    },
    {
        "currency": "BCH",
        "name": null,
        "rate": "0.0012175374088368865"
    },
    {
        "currency": "BSV",
        "name": null,
        "rate": "0.004037505797698844"
    },
    {
        "currency": "ETH",
        "name": null,
        "rate": "0.0004271222637479979"
    },
    {
        "currency": "ETH2",
        "name": null,
        "rate": "0.0004271222637479979"
    },
    {
        "currency": "ETC",
        "name": null,
        "rate": "0.031614555341279126"
    },
    {
        "currency": "LTC",
        "name": null,
        "rate": "0.004191905430613485"
    },
    {
        "currency": "ZRX",
        "name": null,
        "rate": "0.6923313913437805"
    },
    {
        "currency": "USDC",
        "name": null,
        "rate": "1.0"
    },
    {
        "currency": "BAT",
        "name": null,
        "rate": "0.8807910913265858"
    },
    {
        "currency": "MANA",
        "name": null,
        "rate": "0.8459614224672126"
    },
    {
        "currency": "KNC",
        "name": null,
        "rate": "0.39842224789832265"
    },
    {
        "currency": "LINK",
        "name": null,
        "rate": "0.02896534904259384"
    },
    {
        "currency": "DNT",
        "name": null,
        "rate": "3.61274286663921"
    },
    {
        "currency": "MKR",
        "name": null,
        "rate": "0.00024049389268765697"
    },
    {
        "currency": "CVC",
        "name": null,
        "rate": "2.2605562324665605"
    },
    {
        "currency": "OMG",
        "name": null,
        "rate": "0.15610974515084103"
    },
    {
        "currency": "DAI",
        "name": null,
        "rate": "0.9998300288950879"
    },
    {
        "currency": "ZEC",
        "name": null,
        "rate": "0.0046328468844104706"
    },
    {
        "currency": "REP",
        "name": null,
        "rate": "0.026371308016877634"
    },
    {
        "currency": "XLM",
        "name": null,
        "rate": "2.255266893922394"
    },
    {
        "currency": "EOS",
        "name": null,
        "rate": "0.18417902200939312"
    },
    {
        "currency": "XTZ",
        "name": null,
        "rate": "0.21115533642323975"
    },
    {
        "currency": "ALGO",
        "name": null,
        "rate": "0.8571183680466272"
    },
    {
        "currency": "DASH",
        "name": null,
        "rate": "0.0038446603434819553"
    },
    {
        "currency": "ATOM",
        "name": null,
        "rate": "0.05014542172299669"
    },
    {
        "currency": "OXT",
        "name": null,
        "rate": "1.7678776628657298"
    },
    {
        "currency": "COMP",
        "name": null,
        "rate": "0.0016380687169826773"
    },
    {
        "currency": "ENJ",
        "name": null,
        "rate": "0.4544421722335833"
    },
    {
        "currency": "BAND",
        "name": null,
        "rate": "0.06574254561710884"
    },
    {
        "currency": "NMR",
        "name": null,
        "rate": "0.01590994968478412"
    },
    {
        "currency": "CGLD",
        "name": null,
        "rate": "0.20096059162798177"
    },
    {
        "currency": "UMA",
        "name": null,
        "rate": "0.043889486273563164"
    },
    {
        "currency": "LRC",
        "name": null,
        "rate": "2.0874647740319383"
    },
    {
        "currency": "YFI",
        "name": null,
        "rate": "2.3179934706759918e-05"
    },
    {
        "currency": "UNI",
        "name": null,
        "rate": "0.030360346958045036"
    },
    {
        "currency": "BAL",
        "name": null,
        "rate": "0.01991039922142375"
    },
    {
        "currency": "REN",
        "name": null,
        "rate": "1.2809017548354042"
    },
    {
        "currency": "WBTC",
        "name": null,
        "rate": "1.960363412169348e-05"
    },
    {
        "currency": "NU",
        "name": null,
        "rate": "2.5"
    },
    {
        "currency": "FIL",
        "name": null,
        "rate": "0.007345895058746959"
    },
    {
        "currency": "AAVE",
        "name": null,
        "rate": "0.0029484478633335447"
    },
    {
        "currency": "BNT",
        "name": null,
        "rate": "0.1597469608140705"
    },
    {
        "currency": "GRT",
        "name": null,
        "rate": "0.731448634019676"
    },
    {
        "currency": "SNX",
        "name": null,
        "rate": "0.0684078751145832"
    },
    {
        "currency": "STORJ",
        "name": null,
        "rate": "0.5607424229680097"
    },
    {
        "currency": "SUSHI",
        "name": null,
        "rate": "0.08726003490401396"
    },
    {
        "currency": "MATIC",
        "name": null,
        "rate": "2.7203482045701852"
    },
    {
        "currency": "SKL",
        "name": null,
        "rate": "2.087900615930682"
    },
    {
        "currency": "ADA",
        "name": null,
        "rate": "0.8700191404210893"
    },
    {
        "currency": "ANKR",
        "name": null,
        "rate": "7.489795154102535"
    },
    {
        "currency": "CRV",
        "name": null,
        "rate": "0.37921880925293894"
    },
    {
        "currency": "NKN",
        "name": null,
        "rate": "1.64866870002473"
    },
    {
        "currency": "OGN",
        "name": null,
        "rate": "0.6036824630244491"
    },
    {
        "currency": "1INCH",
        "name": null,
        "rate": "0.23618327822390175"
    },
    {
        "currency": "FORTH",
        "name": null,
        "rate": "0.021703508372128356"
    }
];

class ExchangeRatesApi extends DataSource {
    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getExchangeRatesByCurrency(currency) {
        return Promise.resolve(rates);
    }

    async changeExchangeRateForCurrency(currency, newRate) {
        var rate = rates.find(rate => rate.currency === currency);
        rate.rate = newRate;
        return Promise.resolve(rate);
    }
}

module.exports = ExchangeRatesApi;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseSalaryFilter = exports.industryFilter = exports.onSiteOrRemoteFilter = exports.experienceLevelFilter = exports.typeFilter = exports.timeFilter = exports.relevanceFilter = void 0;
exports.relevanceFilter = {
    RELEVANT: "R",
    RECENT: "DD",
};
exports.timeFilter = {
    ANY: "",
    DAY: "r86400",
    WEEK: "r604800",
    MONTH: "r2592000",
};
exports.typeFilter = {
    FULL_TIME: "F",
    PART_TIME: "P",
    TEMPORARY: "T",
    CONTRACT: "C",
    INTERNSHIP: "I",
    VOLUNTEER: "V",
    OTHER: "O",
};
exports.experienceLevelFilter = {
    INTERNSHIP: "1",
    ENTRY_LEVEL: "2",
    ASSOCIATE: "3",
    MID_SENIOR: "4",
    DIRECTOR: "5",
    EXECUTIVE: "6",
};
exports.onSiteOrRemoteFilter = {
    ON_SITE: "1",
    REMOTE: "2",
    HYBRID: "3",
};
exports.industryFilter = {
    AIRLINES_AVIATION: "94",
    BANKING: "41",
    CIVIL_ENGINEERING: "51",
    COMPUTER_GAMES: "109",
    ENVIRONMENTAL_SERVICES: "86",
    ELECTRONIC_MANUFACTURING: "112",
    FINANCIAL_SERVICES: "43",
    INFORMATION_SERVICES: "84",
    INVESTMENT_BANKING: "45",
    INVESTMENT_MANAGEMENT: "46",
    IT_SERVICES: "96",
    LEGAL_SERVICES: "10",
    MOTOR_VEHICLES: "53",
    OIL_GAS: "59",
    SOFTWARE_DEVELOPMENT: "4",
    STAFFING_RECRUITING: "104",
    TECHNOLOGY_INTERNET: "6",
};
exports.baseSalaryFilter = {
    SALARY_40K: '1',
    SALARY_60K: '2',
    SALARY_80K: '3',
    SALARY_100K: '4',
    SALARY_120K: '5',
    SALARY_140K: '6',
    SALARY_160K: '7',
    SALARY_180K: '8',
    SALARY_200K: '9',
};

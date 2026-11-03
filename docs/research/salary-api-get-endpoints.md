# Documented GET endpoints (api.salary.dk Swagger 2.0, fetched 2026-11-03)

Source: https://api.salary.dk/swagger.json (ReDoc UI: https://api.salary.dk/docs). Generated, not hand-edited.

| Endpoint | Summary | Query params | Security |
|---|---|---|---|
| `GET /v2.1/stagedImports/{applyResultID}/result` | Get background staged import apply result |  | authorizedUser |
| `GET /v2.1/stagedImports/{stagedImportID}` | Get the data for background staged import |  | authorizedUser |
| `GET /v2.1/users` | List Users | email | authorizedUser |
| `GET /v2/assetCategories` | List Asset Categories | companyID, limit, offset | authorizedUser |
| `GET /v2/assets` | List Assets | companyID, employeeID, limit, offset | authorizedUser |
| `GET /v2/asynchronousTasks/{asynchronousTaskID}` | Get an asynchronous task |  | authorizedUser |
| `GET /v2/coarseTimeRegistrations` | Get Coarse Time Registrations | payRollID, employeeID, salaryPeriodID, companyID, limit, offset | authorizedUser |
| `GET /v2/companies` | List Companies | limit, offset | authorizedUser |
| `GET /v2/companies/invites/{token}` | Get Company Invitation Information |  |  |
| `GET /v2/companies/{companyID}` | Get Company |  | authorizedUser |
| `GET /v2/companies/{companyID}/absenceStatistics` | Get DS Absence Statistics For Company | year, format, dak | authorizedUser |
| `GET /v2/companies/{companyID}/activePayrolls` | Get active payrolls | employeeID | authorizedUser |
| `GET /v2/companies/{companyID}/advisorCompany` | Get the advisor company for this company |  | authorizedUser |
| `GET /v2/companies/{companyID}/saml` | Get SAML configuration for company |  | authorizedUser |
| `GET /v2/companies/{companyID}/statistics` | Get Statistics For Company | period, year, format, dak | authorizedUser |
| `GET /v2/companies/{companyID}/statistics/overview` | Get Statistics Overview For Company |  | authorizedUser |
| `GET /v2/companies/{companyID}/vacation` | Get Vacation Days For Company | year | authorizedUser |
| `GET /v2/companyDeviationConfigurations` | Get Company Deviation Configurations | companyID | authorizedUser |
| `GET /v2/companyDeviationConfigurations/{id}` | Cet Company Deviation Configuration |  | authorizedUser |
| `GET /v2/companyLogos/{companyID}` |  |  | authorizedUser |
| `GET /v2/companyUsers` | Get all users with access to this company | companyID, limit, offset | authorizedUser |
| `GET /v2/companyUsers/advisor` | Get all advisor users with access to this company | companyID, limit, offset | authorizedUser |
| `GET /v2/companyWhistles` |  | companyID | authorizedUser |
| `GET /v2/departments` | Get Departments | companyID | authorizedUser |
| `GET /v2/documents` |  | companyID, employeeID | authorizedUser |
| `GET /v2/employeeContracts` | Get Employee Contracts | companyID, employeeID, employmentID, employmentType, limit, offset | authorizedUser |
| `GET /v2/employeeContracts/{employeeContractID}` | Get Employee Contract |  | authorizedUser |
| `GET /v2/employeeEmergencyContacts/{employeeID}` | Get Employee Emergency Contact |  | authorizedUser |
| `GET /v2/employeeICalendar/{id}` | Get ical file for employee | key, includeHolidays |  |
| `GET /v2/employeeUsers/{employeeID}` | Get Employee User |  | authorizedUser |
| `GET /v2/employees` | List Employees | companyID, employeeNumber, nationalID, nationalIDType, includeRemuneration, limit, offset | authorizedUser |
| `GET /v2/employees/{employeeID}` | Get Employee |  | authorizedUser |
| `GET /v2/employees/{employeeID}/swipe` | Employee Swipe info |  | authorizedUser |
| `GET /v2/employmentPositions` | Get Standard Employment Positions | country | authorizedUser |
| `GET /v2/employments` | Get Employments | employeeID, companyID, limit, offset | authorizedUser |
| `GET /v2/employments/{employmentID}` | Get Employment |  | authorizedUser |
| `GET /v2/fileImport/template` | Get file import template as an Excel file | salaryPeriodID, companyID, disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/incomeTaxReportFile` | Get Income Tax Report File | payRollID | authorizedUser |
| `GET /v2/incomeTaxReports` | Get Income Tax Report | payRollID, limit, offset | authorizedUser |
| `GET /v2/invoices` | Get Invoices | companyID, payRollID, limit, offset, failed | authorizedUser |
| `GET /v2/invoicesPDF/{id}` | Get Invoice | disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/leaveTypes` | Get Leave Types | companyID, limit, offset | authorizedUser |
| `GET /v2/netsMessages` | Get NETS Messages | companyID, limit, offset | authorizedUser |
| `GET /v2/oneTimePayPensions` | Gets One Time Pay Pensions | employeeID, companyID, payRollID, limit, offset | authorizedUser |
| `GET /v2/oneTimePays` | Get One Time Pays | employeeID, companyID, payRollID, limit, offset, order | authorizedUser |
| `GET /v2/oneTimePays/Excel` | Get One Time Pay Import as Excel File | companyID, oneTimePayType, disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/payRollDeviations` | Get Deviations | payRollID | authorizedUser |
| `GET /v2/payRolls` | Get Pay Rolls | companyID, from, to, limit, offset | authorizedUser |
| `GET /v2/payRolls/{id}` | Get Payroll |  | authorizedUser |
| `GET /v2/paySlips` | Get Pay Slips | employeeID, payRollID, includeCalculations, limit, offset | authorizedUser |
| `GET /v2/paySlips/{id}` | Get Pay Slip |  | authorizedUser |
| `GET /v2/paySlipsPDF` | Get Pay Slips as PDF | employeeID, payRollID, companyID, from, to, disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/paySlipsPDF/{id}` | Get Pay Slip as PDF | disposition, language | authorizedUserQuery/authorizedUser |
| `GET /v2/paySlipsZip` | Get Pay Slips as .zip | employeeID, payRollID, companyID, from, to, disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/paymentConfigurations` | Gets Active Payment Configurations | companyID | authorizedUser |
| `GET /v2/paymentConfigurations/stripe` | Get Active Stripe Configuration | companyID | authorizedUser |
| `GET /v2/paymentConfigurations/zimpler` | Get Active Zimpler Configuration | companyID | authorizedUser |
| `GET /v2/payslipsHTML/{id}` | Get Payslip as HTML | disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/pensionCompanies` | Get pension companies |  | authorizedUser |
| `GET /v2/profileImages/{id}` | Get Raw Profile Image |  |  |
| `GET /v2/recoveryCodes` | Get the recovery codes |  | authorizedUser |
| `GET /v2/reimbursementVouchers/zip` | Get reimbursement vouchers as .zip | companyID, from, to, disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/reportCSV` | Generate Report As CSV | companyID, companyGroupID, from, to, payRollID, voucherID, reimbursementVoucherID, type | authorizedUser |
| `GET /v2/reportExcel` | Generate Report As Excel | companyID, companyGroupID, from, to, payRollID, voucherID, reimbursementVoucherID, type | authorizedUser |
| `GET /v2/reportFile/{id}` | Get Generated Report |  | authorizedUserQuery/authorizedUser |
| `GET /v2/reportPDF` | Generate Report As PDF | companyID, companyGroupID, from, to, payRollID, type | authorizedUser |
| `GET /v2/salaryCycles` | List Salary Cycles | includeSalaryPeriods, companyID, limit, offset | authorizedUser |
| `GET /v2/salaryPeriods` | List Salary Periods | salaryCycleID, companyID, employeeID, date, limit, offset | authorizedUser |
| `GET /v2/salaryRegistrations` | List salary registrations | employeeID, companyID, payRollID, from, to, stateFilter, limit, offset | authorizedUser |
| `GET /v2/salaryTypes` | Get Salary Types | companyID, limit, offset | authorizedUser |
| `GET /v2/startBalances/{employmentID}` | Get Start Balance For Employment |  | authorizedUser |
| `GET /v2/supplementBalances` | Get Supplements Balances | employeeID, companyID, limit, offset | authorizedUser |
| `GET /v2/supplementTypes` | Get Supplement Types | companyID | authorizedUser |
| `GET /v2/swipes` | List Swipes | employeeID, companyID, payRollID, limit, offset | authorizedUser |
| `GET /v2/swipes/{swipeID}` | Get Swipe |  | authorizedUser |
| `GET /v2/taxCardRequests` | Get Tax Card Requests | employeeID, limit, offset | authorizedUser |
| `GET /v2/taxCards` | Get Tax Cards | employeeID, companyID, limit, offset | authorizedUser |
| `GET /v2/timeRegistrations` | List Time Registrations | employeeID, companyID, payRollID, projectID, from, to, stateFilter, limit, offset | authorizedUser |
| `GET /v2/timeRegistrations/Excel` | Get time registrations as an Excel file | salaryPeriodID, companyID, template, disposition | authorizedUserQuery/authorizedUser |
| `GET /v2/transactions` | Get Employee Transactions | employeeID, limit, offset | authorizedUser |
| `GET /v2/transactions/sums` | Get transaction sums | employeeID | authorizedUser |
| `GET /v2/transactions/{id}` | Get Transaction Details |  | authorizedUser |
| `GET /v2/transfers` | Get Transfers | payRollID, companyID, includeDetails, from, to, limit, offset | authorizedUser |
| `GET /v2/userCompanies` | Get User Companies | limit, offset | authorizedUser |
| `GET /v2/userCompanies/{companyID}` | Get User Company Settings |  | authorizedUser |
| `GET /v2/userDepartments/{companyID}` | Get User Department Settings | userID | authorizedUser |
| `GET /v2/userInvites` | Get Pending User Invites | companyID, companyGroupID, limit, offset | authorizedUser |
| `GET /v2/userInvites/{token}` | Get User Invitation Information |  |  |
| `GET /v2/users` | Get User Information |  | authorizedUser |
| `GET /v2/users/{id}` | Get User |  | authorizedUser |
| `GET /v2/vouchers` | Get Vouchers | payRollID, companyID, limit, offset | authorizedUser |
| `GET /v2/warnings` | Get Warnings | companyID, limit, offset | authorizedUser |
| `GET /v2/whistles` |  | code |  |

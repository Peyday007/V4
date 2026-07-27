-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'HYBRID', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "CompanyRole" AS ENUM ('BUYER', 'PRIME_CONTRACTOR', 'SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'MANUFACTURER', 'CARRIER', 'HYBRID', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('BUYER', 'PRIME_CONTRACTOR', 'SUBCONTRACTOR', 'SUPPLIER', 'DISTRIBUTOR', 'CARRIER', 'CANDIDATE', 'REFERRER');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('SIGNAL_DISCOVERED', 'RESEARCHING', 'QUALIFICATION_REQUIRED', 'BUYER_NEED_CONFIRMED', 'SUPPLIER_REQUIRED', 'FULFILLMENT_CAPABILITY_CONFIRMED', 'MATCH_BEING_CONFIGURED', 'PRICING_REQUIRED', 'QUOTE_BEING_PREPARED', 'QUOTE_DELIVERED', 'FOLLOW_UP_REQUIRED', 'NEGOTIATION', 'AWAITING_APPROVAL', 'CONTRACTING', 'FULFILLMENT_SCHEDULED', 'ACTIVE_FULFILLMENT', 'COMPLETED', 'REPEAT_OR_EXPANSION', 'LOST', 'DORMANT', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('ACTIVE', 'WAITING', 'BLOCKED', 'ESCALATED', 'WON', 'LOST', 'DORMANT', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('CONFIRMED', 'CLAIMED', 'ESTIMATED', 'INFERRED', 'CONTRADICTED', 'STALE', 'MISSING');

-- CreateEnum
CREATE TYPE "SignalCategory" AS ENUM ('SUBCONTRACTING', 'BROKERAGE', 'DISTRIBUTION', 'GENERAL');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('NEW', 'TRIAGED', 'PROMOTED', 'DISMISSED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('COMPANY_WEBSITE', 'SEARCH_ENGINE', 'BUSINESS_DIRECTORY', 'PROCUREMENT_PORTAL', 'CONTRACT_AWARD', 'BID_RFP_PORTAL', 'BUILDING_PERMIT', 'PLANNING_RECORD', 'LICENSE_DATABASE', 'TRADE_ASSOCIATION', 'PRESS_RELEASE', 'JOB_POSTING', 'SUPPLIER_DIRECTORY', 'PUBLIC_VENDOR_LIST', 'PROPERTY_RECORD', 'TRADE_RECORD', 'CALL_TRANSCRIPT', 'CRM_IMPORT', 'USER_UPLOAD', 'EMAIL_INTEGRATION', 'DATA_PROVIDER_API', 'MANUAL_ENTRY');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CallAssignmentStatus" AS ENUM ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'VOICEMAIL', 'RESCHEDULED', 'CANCELLED', 'BLOCKED_BY_COMPLIANCE');

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('BUYER_QUALIFICATION', 'PRIME_QUALIFICATION', 'SUBCONTRACTOR_RECRUITMENT', 'SUPPLIER_QUALIFICATION', 'AVAILABILITY_CONFIRMATION', 'PRICING_REQUEST', 'QUOTE_FOLLOW_UP', 'TRIAL_ORDER_REQUEST', 'BACKUP_PROVIDER_POSITIONING', 'NEGOTIATION_SUPPORT', 'EXPANSION_REQUEST', 'RELATIONSHIP_REACTIVATION', 'FULFILLMENT_ISSUE');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('CONNECTED', 'NO_ANSWER', 'VOICEMAIL', 'GATEKEEPER', 'WRONG_NUMBER', 'CALLBACK_SCHEDULED', 'REFUSED', 'DO_NOT_CALL');

-- CreateEnum
CREATE TYPE "NextActionType" AS ENUM ('RESEARCH_COMPANY', 'FIND_DECISION_MAKER', 'QUALIFY_BUYER_NEED', 'QUALIFY_SCOPE', 'CONFIRM_BUDGET', 'CONFIRM_LOCATION', 'CONFIRM_TIMELINE', 'CONFIRM_SPECIFICATIONS', 'FIND_SUBCONTRACTORS', 'FIND_SUPPLIERS', 'CONFIRM_CAPACITY', 'CONFIRM_AVAILABILITY', 'VERIFY_LICENSING_INSURANCE', 'REQUEST_PRICING', 'OBTAIN_FREIGHT_PRICING', 'BUILD_COMPARISON', 'PREPARE_QUOTE', 'SEND_QUOTE', 'FOLLOW_UP_QUOTE', 'REQUEST_TRIAL', 'REQUEST_BACKUP_STATUS', 'NEGOTIATE', 'REQUEST_DOCUMENTS', 'OBTAIN_APPROVAL', 'GENERATE_AGREEMENT', 'SCHEDULE_FULFILLMENT', 'CHECK_ACTIVE_WORK', 'RESOLVE_BLOCKER', 'INVOICE', 'COLLECT_PAYMENT', 'REQUEST_REPEAT_BUSINESS', 'EXPAND_ACCOUNT', 'PAUSE', 'DISQUALIFY', 'ESCALATE');

-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('LOW_CONFIDENCE', 'CONFLICTING_INFORMATION', 'UNCLEAR_SPECIFICATION', 'INSUFFICIENT_INSURANCE', 'INSUFFICIENT_LICENSING', 'INCONSISTENT_PRICING', 'MARGIN_BELOW_THRESHOLD', 'CASH_EXPOSURE', 'PAYMENT_RISK', 'CONTRACT_VALUE_LIMIT', 'LEGAL_OR_REGULATORY', 'EXCLUSIVITY_REQUESTED', 'DISPUTE_DEVELOPING', 'UNAUTHORIZED_COMMITMENT', 'NO_SAFE_NEXT_ACTION', 'DEAL_READY_FOR_REVIEW');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('DEAL_TERMS', 'PRICING', 'MARGIN_EXCEPTION', 'CONTRACT_EXECUTION', 'CREDIT_TERMS', 'EXCLUSIVITY', 'FULFILLMENT_RELEASE', 'DOCUMENT_SEND');

-- CreateEnum
CREATE TYPE "MovabilityClass" AS ENUM ('ACTIVELY_MOVABLE', 'CONDITIONALLY_MOVABLE', 'RELATIONSHIP_LOCKED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AccountStage" AS ENUM ('DISCOVERED', 'CONTACTED', 'QUALIFIED', 'BACKUP_OPTION', 'TRIAL_OPPORTUNITY', 'FIRST_DEAL', 'REPEAT_DEAL', 'PARTIAL_ACCOUNT', 'PREFERRED_PROVIDER', 'EXPANDED_ACCOUNT', 'STRATEGIC_ACCOUNT');

-- CreateEnum
CREATE TYPE "RelationshipKind" AS ENUM ('SUPPLIES', 'BUYS_FROM', 'SUBCONTRACTS_TO', 'SUBCONTRACTS_FOR', 'PARTNERS_WITH', 'COMPETES_WITH', 'PARENT_OF', 'SUBSIDIARY_OF', 'INCUMBENT_VENDOR_OF', 'FORMER_VENDOR_OF');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('INTRO_EMAIL', 'CAPABILITY_REQUEST', 'SCOPE_REQUEST', 'PRICING_REQUEST', 'SUBCONTRACTOR_INVITATION', 'BUYER_FOLLOW_UP', 'QUOTE_FOLLOW_UP', 'MEETING_SUMMARY', 'OPPORTUNITY_BRIEF', 'SUBCONTRACTOR_COMPARISON', 'SUPPLIER_COMPARISON', 'QUOTE', 'PROPOSAL', 'STATEMENT_OF_WORK', 'PURCHASE_ORDER', 'CONTRACT', 'CHANGE_ORDER', 'FULFILLMENT_INSTRUCTIONS', 'INTERNAL_APPROVAL_SUMMARY', 'CERTIFICATE_OF_INSURANCE', 'LICENSE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'SIGNED', 'VOID');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('EMAIL', 'SMS', 'VOICEMAIL_DROP', 'INTERNAL_NOTE');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'QUEUED', 'SENT', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('DO_NOT_CALL', 'DO_NOT_EMAIL', 'DO_NOT_SMS', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "LaneRecommendation" AS ENUM ('SCALE', 'CONTINUE_TESTING', 'IMPROVE_FULFILLMENT_COVERAGE', 'IMPROVE_SCRIPT', 'CHANGE_TARGET_PROFILE', 'PAUSE', 'ABANDON', 'INSUFFICIENT_DATA');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallerProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "industryStrengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "callTypeStrengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxDailyCalls" INTEGER NOT NULL DEFAULT 40,
    "coldCallSkill" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "warmCallSkill" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "objectionSkill" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "extractionAccuracy" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "buyerSideSkill" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "supplySideSkill" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Industry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Industry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "specs" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'ton',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capability" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'county',
    "region" TEXT,
    "state" TEXT,
    "postalCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigSetting" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ConfigSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualificationQuestion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callType" "CallType" NOT NULL,
    "opportunityType" "OpportunityType",
    "prompt" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "QualificationQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callType" "CallType" NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "opener" TEXT NOT NULL,
    "branches" JSONB NOT NULL DEFAULT '[]',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "mayOffer" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mayNotPromise" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalateIf" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "operatingName" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "description" TEXT,
    "companyRole" "CompanyRole" NOT NULL DEFAULT 'UNKNOWN',
    "employeeCount" INTEGER,
    "estimatedRevenue" DECIMAL(14,2),
    "revenueSource" TEXT,
    "yearFounded" INTEGER,
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "licenses" JSONB NOT NULL DEFAULT '[]',
    "insurance" JSONB NOT NULL DEFAULT '{}',
    "govRegistrations" JSONB NOT NULL DEFAULT '{}',
    "serviceTerritories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "purchasingPatterns" JSONB NOT NULL DEFAULT '{}',
    "fulfillmentCapacity" JSONB NOT NULL DEFAULT '{}',
    "movability" "MovabilityClass" NOT NULL DEFAULT 'UNKNOWN',
    "movabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "movabilityReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountStage" "AccountStage" NOT NULL DEFAULT 'DISCOVERED',
    "relationshipStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedLifetimeValue" DECIMAL(14,2),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyLocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Primary',
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isHeadquarters" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompanyLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyIndustry" (
    "companyId" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompanyIndustry_pkey" PRIMARY KEY ("companyId","industryId")
);

-- CreateTable
CREATE TABLE "CompanyCapability" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "status" "FactStatus" NOT NULL DEFAULT 'CLAIMED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidenceId" TEXT,
    "notes" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "CompanyCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyProduct" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'supplies',
    "unitCost" DECIMAL(12,4),
    "leadTimeDays" INTEGER,
    "notes" TEXT,

    CONSTRAINT "CompanyProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "title" TEXT,
    "department" TEXT,
    "buyingRole" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "preferredChannel" TEXT NOT NULL DEFAULT 'phone',
    "bestContactTime" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "decisionAuthority" TEXT NOT NULL DEFAULT 'unknown',
    "influenceLevel" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "knownPriorities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consentToCall" BOOLEAN NOT NULL DEFAULT true,
    "consentToRecord" BOOLEAN,
    "consentToEmail" BOOLEAN NOT NULL DEFAULT true,
    "lastInteractionAt" TIMESTAMP(3),
    "nextInteractionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fromCompanyId" TEXT NOT NULL,
    "toCompanyId" TEXT NOT NULL,
    "kind" "RelationshipKind" NOT NULL,
    "status" "FactStatus" NOT NULL DEFAULT 'INFERRED',
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "since" TIMESTAMP(3),
    "until" TIMESTAMP(3),
    "notes" TEXT,
    "evidenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "connector" TEXT NOT NULL,
    "baseUrl" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "accessBasis" TEXT NOT NULL,
    "rateLimitPerMin" INTEGER NOT NULL DEFAULT 30,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEvidence" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dataSourceId" TEXT,
    "companyId" TEXT,
    "sourceType" "SourceType" NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT,
    "excerpt" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" "FactStatus" NOT NULL DEFAULT 'INFERRED',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByProcess" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "SourceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoverySignal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "dataSourceId" TEXT,
    "evidenceId" TEXT,
    "companyId" TEXT,
    "category" "SignalCategory" NOT NULL,
    "signalKey" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "location" TEXT,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" "SignalStatus" NOT NULL DEFAULT 'NEW',
    "dedupeHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoverySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "state" TEXT,
    "value" DECIMAL(14,2),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "trades" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'announced',
    "evidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractAward" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "winnerCompanyId" TEXT,
    "issuerCompanyId" TEXT,
    "agency" TEXT,
    "solicitationNumber" TEXT,
    "title" TEXT NOT NULL,
    "scopeSummary" TEXT,
    "value" DECIMAL(14,2),
    "awardDate" TIMESTAMP(3),
    "performanceStart" TIMESTAMP(3),
    "performanceEnd" TIMESTAMP(3),
    "subcontractingGoalPct" DOUBLE PRECISION,
    "location" TEXT,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractAward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerNeed" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT,
    "opportunityType" "OpportunityType" NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "location" TEXT,
    "state" TEXT,
    "requiredCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredCertifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "insuranceRequirement" JSONB NOT NULL DEFAULT '{}',
    "quantity" DECIMAL(14,3),
    "unit" TEXT,
    "frequency" TEXT,
    "startDate" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "estimatedValue" DECIMAL(14,2),
    "currentProvider" TEXT,
    "currentProviderIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openToAlternatives" BOOLEAN,
    "status" "FactStatus" NOT NULL DEFAULT 'INFERRED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "missingFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerNeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAvailability" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3),
    "unit" TEXT,
    "unitCost" DECIMAL(12,4),
    "freightBasis" TEXT,
    "leadTimeDays" INTEGER,
    "location" TEXT,
    "availableFrom" TIMESTAMP(3),
    "availableTo" TIMESTAMP(3),
    "minimumOrder" DECIMAL(14,3),
    "status" "FactStatus" NOT NULL DEFAULT 'CLAIMED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "verifiedAt" TIMESTAMP(3),
    "staleAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractorCapacity" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "territories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "crewCount" INTEGER,
    "shiftAvailability" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minimumContract" DECIMAL(14,2),
    "earliestStart" TIMESTAMP(3),
    "insuranceLimits" JSONB NOT NULL DEFAULT '{}',
    "licenses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hourlyRate" DECIMAL(12,2),
    "monthlyRate" DECIMAL(12,2),
    "suppliesConsumables" BOOLEAN,
    "status" "FactStatus" NOT NULL DEFAULT 'CLAIMED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "verifiedAt" TIMESTAMP(3),
    "staleAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubcontractorCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL DEFAULT 'UNCLASSIFIED',
    "stage" "PipelineStage" NOT NULL DEFAULT 'SIGNAL_DISCOVERED',
    "status" "OpportunityStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "ownerId" TEXT,
    "laneId" TEXT,
    "signalId" TEXT,
    "buyerNeedId" TEXT,
    "projectId" TEXT,
    "awardId" TEXT,
    "location" TEXT,
    "state" TEXT,
    "summary" TEXT NOT NULL,
    "estimatedValue" DECIMAL(14,2),
    "estimatedGrossProfit" DECIMAL(14,2),
    "closingProbability" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "fulfillmentConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "expectedValue" DECIMAL(14,2),
    "urgency" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "informationCompleteness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "relationshipVulnerability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "primaryBlocker" TEXT,
    "missingInformation" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wedgeStrategy" TEXT,
    "aiExplanation" TEXT,
    "dueDate" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityParty" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "PartyRole" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityScore" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "needStrength" DOUBLE PRECISION NOT NULL,
    "capabilityMatch" DOUBLE PRECISION NOT NULL,
    "urgency" DOUBLE PRECISION NOT NULL,
    "informationCompleteness" DOUBLE PRECISION NOT NULL,
    "contactability" DOUBLE PRECISION NOT NULL,
    "switchingWillingness" DOUBLE PRECISION NOT NULL,
    "incumbentWeakness" DOUBLE PRECISION NOT NULL,
    "supplyAvailability" DOUBLE PRECISION NOT NULL,
    "expectedGrossProfit" DECIMAL(14,2) NOT NULL,
    "closingProbability" DOUBLE PRECISION NOT NULL,
    "repeatPotential" DOUBLE PRECISION NOT NULL,
    "expansionValue" DOUBLE PRECISION NOT NULL,
    "fulfillmentRisk" DOUBLE PRECISION NOT NULL,
    "paymentRisk" DOUBLE PRECISION NOT NULL,
    "complianceRisk" DOUBLE PRECISION NOT NULL,
    "competitivePressure" DOUBLE PRECISION NOT NULL,
    "timeToClose" DOUBLE PRECISION NOT NULL,
    "compositeScore" DOUBLE PRECISION NOT NULL,
    "expectedValue" DECIMAL(14,2) NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "modelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealStatusHistory" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStage" "PipelineStage",
    "toStage" "PipelineStage" NOT NULL,
    "fromStatus" "OpportunityStatus",
    "toStatus" "OpportunityStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "decisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "buyerPrice" DECIMAL(14,2),
    "supplierCost" DECIMAL(14,2),
    "freightCost" DECIMAL(14,2),
    "otherCost" DECIMAL(14,2),
    "grossProfit" DECIMAL(14,2),
    "grossMarginPct" DOUBLE PRECISION,
    "paymentTerms" TEXT,
    "deliveryTerms" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "risks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredApprovals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isConfigurable" BOOLEAN NOT NULL DEFAULT false,
    "configuredAt" TIMESTAMP(3),
    "configuredBy" TEXT NOT NULL DEFAULT 'ai',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cost" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "FactStatus" NOT NULL DEFAULT 'ESTIMATED',
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Margin" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "grossProfit" DECIMAL(14,2) NOT NULL,
    "grossMarginPct" DOUBLE PRECISION NOT NULL,
    "belowThreshold" BOOLEAN NOT NULL DEFAULT false,
    "thresholdPct" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Margin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "candidateCompanyId" TEXT NOT NULL,
    "buyerNeedId" TEXT,
    "supplyId" TEXT,
    "capacityId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "explanation" TEXT NOT NULL,
    "confirmedFactors" JSONB NOT NULL DEFAULT '[]',
    "potentialMismatches" JSONB NOT NULL DEFAULT '[]',
    "missingInformation" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estimatedCost" DECIMAL(14,2),
    "estimatedRevenue" DECIMAL(14,2),
    "estimatedGrossProfit" DECIMAL(14,2),
    "closingProbability" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "fulfillmentRisk" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "callsNeeded" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "companyId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "quoteNumber" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "freight" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grossProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "unitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "lineCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "QuoteLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "assignedToId" TEXT,
    "scriptId" TEXT,
    "callType" "CallType" NOT NULL,
    "status" "CallAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "reason" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "knownInformation" JSONB NOT NULL DEFAULT '[]',
    "missingInformation" JSONB NOT NULL DEFAULT '[]',
    "requiredQuestions" JSONB NOT NULL DEFAULT '[]',
    "optionalQuestions" JSONB NOT NULL DEFAULT '[]',
    "desiredCommitment" TEXT NOT NULL,
    "mayOffer" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mayNotPromise" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalateIf" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previousSummary" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "scheduledFor" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assignmentReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "contactId" TEXT,
    "callerId" TEXT,
    "direction" "CallDirection" NOT NULL DEFAULT 'OUTBOUND',
    "providerCallId" TEXT,
    "fromNumber" TEXT,
    "toNumber" TEXT,
    "outcome" "CallOutcome",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "talkRatio" DOUBLE PRECISION,
    "recordingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentBasis" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallRecording" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "durationSec" INTEGER,
    "sizeBytes" INTEGER,
    "provider" TEXT NOT NULL,
    "announcementPlayed" BOOLEAN NOT NULL DEFAULT false,
    "retentionUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "text" TEXT NOT NULL,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "redactions" JSONB NOT NULL DEFAULT '[]',
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedFact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "transcriptId" TEXT,
    "callId" TEXT,
    "evidenceId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "opportunityId" TEXT,
    "factKey" TEXT NOT NULL,
    "factValue" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL DEFAULT '{}',
    "status" "FactStatus" NOT NULL DEFAULT 'CLAIMED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sourceQuote" TEXT,
    "timestampSec" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverifyAfter" TIMESTAMP(3),
    "supersededById" TEXT,
    "appliedTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extractorVersion" TEXT NOT NULL DEFAULT 'v1',

    CONSTRAINT "ExtractedFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callId" TEXT,
    "contactId" TEXT,
    "opportunityId" TEXT,
    "madeBy" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "isAuthorized" BOOLEAN NOT NULL DEFAULT true,
    "fulfilled" BOOLEAN NOT NULL DEFAULT false,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Objection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "callId" TEXT,
    "contactId" TEXT,
    "category" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "responseUsed" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Objection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "ownerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'general',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByProcess" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NextAction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "NextActionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "ownerId" TEXT,
    "ownerRole" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "inputsRequired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedResult" TEXT NOT NULL,
    "completionCriteria" TEXT NOT NULL,
    "fallbackAction" "NextActionType",
    "escalationCondition" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "completedAt" TIMESTAMP(3),
    "createdByProcess" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NextAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "reason" "EscalationReason" NOT NULL,
    "severity" "Priority" NOT NULL DEFAULT 'HIGH',
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "raisedById" TEXT,
    "raisedByProcess" TEXT NOT NULL DEFAULT 'ai',
    "assigneeId" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "dealId" TEXT,
    "documentId" TEXT,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "requiredRole" TEXT NOT NULL DEFAULT 'DEAL_MANAGER',
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "dealId" TEXT,
    "companyId" TEXT,
    "kind" "DocumentKind" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "isConfidential" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "generatedBy" TEXT NOT NULL DEFAULT 'ai',
    "modelVersion" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "contactId" TEXT,
    "channel" "MessageChannel" NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "status" "MessageStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "userId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'ai',
    "verb" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIRecommendation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIDecision" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "process" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "outputs" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "rulesApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modelName" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "outcome" TEXT,
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIOverride" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "previous" JSONB NOT NULL DEFAULT '{}',
    "replacement" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceMetric" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'caller',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealLane" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "opportunityType" "OpportunityType" NOT NULL,
    "industryId" TEXT,
    "targetProfile" JSONB NOT NULL DEFAULT '{}',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "laneScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recommendation" "LaneRecommendation" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "recommendationReason" TEXT,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealLane_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "scope" "SuppressionScope" NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "result" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPlan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "planDate" TIMESTAMP(3) NOT NULL,
    "priorities" JSONB NOT NULL DEFAULT '[]',
    "narrative" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "generatedBy" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Role_orgId_idx" ON "Role"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_orgId_key_key" ON "Role"("orgId", "key");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "User_orgId_email_key" ON "User"("orgId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CallerProfile_userId_key" ON "CallerProfile"("userId");

-- CreateIndex
CREATE INDEX "Industry_orgId_idx" ON "Industry"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Industry_orgId_key_key" ON "Industry"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Service_orgId_key_key" ON "Service"("orgId", "key");

-- CreateIndex
CREATE INDEX "Product_orgId_category_idx" ON "Product"("orgId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Product_orgId_name_key" ON "Product"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Material_orgId_key_key" ON "Material"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_orgId_key_key" ON "Capability"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Territory_orgId_name_key" ON "Territory"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigSetting_orgId_key_key" ON "ConfigSetting"("orgId", "key");

-- CreateIndex
CREATE INDEX "QualificationQuestion_orgId_callType_idx" ON "QualificationQuestion"("orgId", "callType");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptTemplate_orgId_callType_version_key" ON "ScriptTemplate"("orgId", "callType", "version");

-- CreateIndex
CREATE INDEX "Company_orgId_companyRole_idx" ON "Company"("orgId", "companyRole");

-- CreateIndex
CREATE INDEX "Company_orgId_movability_idx" ON "Company"("orgId", "movability");

-- CreateIndex
CREATE UNIQUE INDEX "Company_orgId_legalName_key" ON "Company"("orgId", "legalName");

-- CreateIndex
CREATE INDEX "CompanyLocation_companyId_idx" ON "CompanyLocation"("companyId");

-- CreateIndex
CREATE INDEX "CompanyLocation_state_city_idx" ON "CompanyLocation"("state", "city");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyCapability_companyId_capabilityId_key" ON "CompanyCapability"("companyId", "capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyProduct_companyId_productId_role_key" ON "CompanyProduct"("companyId", "productId", "role");

-- CreateIndex
CREATE INDEX "Contact_orgId_companyId_idx" ON "Contact"("orgId", "companyId");

-- CreateIndex
CREATE INDEX "Contact_orgId_lastName_idx" ON "Contact"("orgId", "lastName");

-- CreateIndex
CREATE INDEX "Relationship_orgId_idx" ON "Relationship"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Relationship_fromCompanyId_toCompanyId_kind_key" ON "Relationship"("fromCompanyId", "toCompanyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_orgId_key_key" ON "DataSource"("orgId", "key");

-- CreateIndex
CREATE INDEX "SourceEvidence_orgId_sourceType_idx" ON "SourceEvidence"("orgId", "sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "SourceEvidence_orgId_contentHash_key" ON "SourceEvidence"("orgId", "contentHash");

-- CreateIndex
CREATE INDEX "DiscoverySignal_orgId_status_category_idx" ON "DiscoverySignal"("orgId", "status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoverySignal_orgId_dedupeHash_key" ON "DiscoverySignal"("orgId", "dedupeHash");

-- CreateIndex
CREATE INDEX "Project_orgId_idx" ON "Project"("orgId");

-- CreateIndex
CREATE INDEX "ContractAward_orgId_idx" ON "ContractAward"("orgId");

-- CreateIndex
CREATE INDEX "BuyerNeed_orgId_companyId_idx" ON "BuyerNeed"("orgId", "companyId");

-- CreateIndex
CREATE INDEX "SupplierAvailability_orgId_companyId_idx" ON "SupplierAvailability"("orgId", "companyId");

-- CreateIndex
CREATE INDEX "SubcontractorCapacity_orgId_companyId_idx" ON "SubcontractorCapacity"("orgId", "companyId");

-- CreateIndex
CREATE INDEX "Opportunity_orgId_stage_idx" ON "Opportunity"("orgId", "stage");

-- CreateIndex
CREATE INDEX "Opportunity_orgId_status_priority_idx" ON "Opportunity"("orgId", "status", "priority");

-- CreateIndex
CREATE INDEX "Opportunity_orgId_type_idx" ON "Opportunity"("orgId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityParty_opportunityId_companyId_role_key" ON "OpportunityParty"("opportunityId", "companyId", "role");

-- CreateIndex
CREATE INDEX "OpportunityScore_opportunityId_createdAt_idx" ON "OpportunityScore"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "DealStatusHistory_opportunityId_createdAt_idx" ON "DealStatusHistory"("opportunityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_opportunityId_key" ON "Deal"("opportunityId");

-- CreateIndex
CREATE INDEX "Deal_orgId_idx" ON "Deal"("orgId");

-- CreateIndex
CREATE INDEX "Cost_dealId_idx" ON "Cost"("dealId");

-- CreateIndex
CREATE INDEX "Margin_dealId_idx" ON "Margin"("dealId");

-- CreateIndex
CREATE INDEX "Match_orgId_idx" ON "Match"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_opportunityId_candidateCompanyId_key" ON "Match"("opportunityId", "candidateCompanyId");

-- CreateIndex
CREATE INDEX "Quote_orgId_status_idx" ON "Quote"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_orgId_quoteNumber_key" ON "Quote"("orgId", "quoteNumber");

-- CreateIndex
CREATE INDEX "QuoteLineItem_quoteId_idx" ON "QuoteLineItem"("quoteId");

-- CreateIndex
CREATE INDEX "CallAssignment_orgId_assignedToId_status_idx" ON "CallAssignment"("orgId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "CallAssignment_orgId_status_priority_idx" ON "CallAssignment"("orgId", "status", "priority");

-- CreateIndex
CREATE INDEX "Call_orgId_callerId_startedAt_idx" ON "Call"("orgId", "callerId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallRecording_callId_key" ON "CallRecording"("callId");

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_callId_key" ON "Transcript"("callId");

-- CreateIndex
CREATE INDEX "ExtractedFact_orgId_factKey_idx" ON "ExtractedFact"("orgId", "factKey");

-- CreateIndex
CREATE INDEX "ExtractedFact_opportunityId_idx" ON "ExtractedFact"("opportunityId");

-- CreateIndex
CREATE INDEX "Commitment_orgId_fulfilled_idx" ON "Commitment"("orgId", "fulfilled");

-- CreateIndex
CREATE INDEX "Objection_orgId_category_idx" ON "Objection"("orgId", "category");

-- CreateIndex
CREATE INDEX "Task_orgId_status_dueDate_idx" ON "Task"("orgId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "NextAction_orgId_isCurrent_dueDate_idx" ON "NextAction"("orgId", "isCurrent", "dueDate");

-- CreateIndex
CREATE INDEX "NextAction_opportunityId_isCurrent_idx" ON "NextAction"("opportunityId", "isCurrent");

-- CreateIndex
CREATE INDEX "Escalation_orgId_status_severity_idx" ON "Escalation"("orgId", "status", "severity");

-- CreateIndex
CREATE INDEX "Approval_orgId_status_idx" ON "Approval"("orgId", "status");

-- CreateIndex
CREATE INDEX "Document_orgId_kind_status_idx" ON "Document"("orgId", "kind", "status");

-- CreateIndex
CREATE INDEX "Message_orgId_status_idx" ON "Message"("orgId", "status");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_orgId_createdAt_idx" ON "ActivityEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_opportunityId_createdAt_idx" ON "ActivityEvent"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "AIRecommendation_orgId_status_idx" ON "AIRecommendation"("orgId", "status");

-- CreateIndex
CREATE INDEX "AIDecision_orgId_process_createdAt_idx" ON "AIDecision"("orgId", "process", "createdAt");

-- CreateIndex
CREATE INDEX "AIOverride_orgId_createdAt_idx" ON "AIOverride"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PerformanceMetric_orgId_userId_periodStart_idx" ON "PerformanceMetric"("orgId", "userId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "DealLane_orgId_key_key" ON "DealLane"("orgId", "key");

-- CreateIndex
CREATE INDEX "SuppressionEntry_orgId_phone_idx" ON "SuppressionEntry"("orgId", "phone");

-- CreateIndex
CREATE INDEX "SuppressionEntry_orgId_email_idx" ON "SuppressionEntry"("orgId", "email");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_priority_idx" ON "Job"("status", "runAfter", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "Job_orgId_idempotencyKey_key" ON "Job"("orgId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_orgId_planDate_key" ON "DailyPlan"("orgId", "planDate");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallerProfile" ADD CONSTRAINT "CallerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Industry" ADD CONSTRAINT "Industry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSetting" ADD CONSTRAINT "ConfigSetting_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationQuestion" ADD CONSTRAINT "QualificationQuestion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptTemplate" ADD CONSTRAINT "ScriptTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyLocation" ADD CONSTRAINT "CompanyLocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyIndustry" ADD CONSTRAINT "CompanyIndustry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyIndustry" ADD CONSTRAINT "CompanyIndustry_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyCapability" ADD CONSTRAINT "CompanyCapability_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyCapability" ADD CONSTRAINT "CompanyCapability_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyCapability" ADD CONSTRAINT "CompanyCapability_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SourceEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProduct" ADD CONSTRAINT "CompanyProduct_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProduct" ADD CONSTRAINT "CompanyProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_fromCompanyId_fkey" FOREIGN KEY ("fromCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_toCompanyId_fkey" FOREIGN KEY ("toCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SourceEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEvidence" ADD CONSTRAINT "SourceEvidence_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEvidence" ADD CONSTRAINT "SourceEvidence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySignal" ADD CONSTRAINT "DiscoverySignal_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySignal" ADD CONSTRAINT "DiscoverySignal_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SourceEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverySignal" ADD CONSTRAINT "DiscoverySignal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAward" ADD CONSTRAINT "ContractAward_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAward" ADD CONSTRAINT "ContractAward_winnerCompanyId_fkey" FOREIGN KEY ("winnerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAward" ADD CONSTRAINT "ContractAward_issuerCompanyId_fkey" FOREIGN KEY ("issuerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerNeed" ADD CONSTRAINT "BuyerNeed_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerNeed" ADD CONSTRAINT "BuyerNeed_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAvailability" ADD CONSTRAINT "SupplierAvailability_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcontractorCapacity" ADD CONSTRAINT "SubcontractorCapacity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "DealLane"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "DiscoverySignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_buyerNeedId_fkey" FOREIGN KEY ("buyerNeedId") REFERENCES "BuyerNeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_awardId_fkey" FOREIGN KEY ("awardId") REFERENCES "ContractAward"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityParty" ADD CONSTRAINT "OpportunityParty_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityParty" ADD CONSTRAINT "OpportunityParty_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityScore" ADD CONSTRAINT "OpportunityScore_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStatusHistory" ADD CONSTRAINT "DealStatusHistory_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cost" ADD CONSTRAINT "Cost_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Margin" ADD CONSTRAINT "Margin_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_candidateCompanyId_fkey" FOREIGN KEY ("candidateCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_buyerNeedId_fkey" FOREIGN KEY ("buyerNeedId") REFERENCES "BuyerNeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "SupplierAvailability"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_capacityId_fkey" FOREIGN KEY ("capacityId") REFERENCES "SubcontractorCapacity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAssignment" ADD CONSTRAINT "CallAssignment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAssignment" ADD CONSTRAINT "CallAssignment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAssignment" ADD CONSTRAINT "CallAssignment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAssignment" ADD CONSTRAINT "CallAssignment_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAssignment" ADD CONSTRAINT "CallAssignment_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "ScriptTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "CallAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallRecording" ADD CONSTRAINT "CallRecording_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SourceEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Objection" ADD CONSTRAINT "Objection_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Objection" ADD CONSTRAINT "Objection_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NextAction" ADD CONSTRAINT "NextAction_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIDecision" ADD CONSTRAINT "AIDecision_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIOverride" ADD CONSTRAINT "AIOverride_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AIDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIOverride" ADD CONSTRAINT "AIOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceMetric" ADD CONSTRAINT "PerformanceMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealLane" ADD CONSTRAINT "DealLane_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealLane" ADD CONSTRAINT "DealLane_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPlan" ADD CONSTRAINT "DailyPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


export interface IQuery {
    query?: string;
    options?: IQueryOptions;
}
export interface IQueryOptions {
    locations?: string[];
    pageOffset?: number;
    limit?: number;
    filters?: {
        companyJobsUrl?: string;
        relevance?: string;
        time?: string;
        baseSalary?: string;
        type?: string | string[];
        experience?: string | string[];
        onSiteOrRemote?: string | string[];
        industry?: string | string[];
    };
    descriptionFn?: () => string;
    optimize?: boolean;
    applyLink?: boolean;
    skipPromotedJobs?: boolean;
    skills?: boolean;
}
export interface IQueryValidationError {
    param: string;
    reason: string;
}
/**
 * Validate query
 * @param {IQuery} query
 * @returns {IQueryValidationError[]}
 */
export declare const validateQuery: (query: IQuery) => IQueryValidationError[];

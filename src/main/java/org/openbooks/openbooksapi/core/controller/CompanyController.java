package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.error.UnbalancedAccountingEntryException;
import org.openbooks.openbooksapi.core.model.Account;
import org.openbooks.openbooksapi.core.model.Company;
import org.openbooks.openbooksapi.core.model.CompanyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.persistence.EntityExistsException;
import java.util.List;

@RestController
@RequestMapping("/companies")
public class CompanyController {

    @Autowired
    private CompanyService companyService;

    @GetMapping
    public List<Company> getCompanies() {
        return companyService.getCompanies();
    }

    @GetMapping("/{id}")
    public Company getCompanyById(@PathVariable Long id) {
        return companyService.getCompanyById(id).get();
    }

    @GetMapping("/{id}/accounts")
    public List<Account> getAccountsForCompany(@PathVariable Long id) {
        return companyService.getAccountsForCompany(id);
    }

    @PostMapping
    public ResponseEntity<Company> createCompany(@RequestBody Company company) {
        if(!company.idIsNull() && companyService.companyExists(company)) {
            throw new EntityExistsException("Company with ID " + company.getId() + " already exists");
        }

        return ResponseEntity.created(null).body(companyService.createCompany(company));
    }

    @PutMapping
    public ResponseEntity<Company> updateCompany(@RequestBody Company company) {
        companyService.companyExists(company);

        return ResponseEntity.ok().body(companyService.updateCompany(company));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<ActionResponse> deleteCompany(@PathVariable Long id) {
        companyService.deleteCompany(id);

        return ResponseEntity.ok().body(new ActionResponse("Company deleted"));
    }
}

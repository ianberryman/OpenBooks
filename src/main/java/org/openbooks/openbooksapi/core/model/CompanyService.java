package org.openbooks.openbooksapi.core.model;

import org.hibernate.Hibernate;
import org.openbooks.openbooksapi.core.repository.CompanyRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;

@Service
public class CompanyService {

    @Autowired
    private CompanyRepository companyRepo;

    @Autowired
    private ChartOfAccountsService coa;

    @Autowired
    private ChartOfAccountsService accounts;

    public Optional<Company> getCompanyById(Long id) {
        return companyRepo.findById(id);
    }

    public List<Company> getCompanies(){
        return companyRepo.findAll();
    }

    @Transactional
    public List<Account> getAccountsForCompany(Long id) {
        return coa.getAccountsByCompany(companyRepo.getOne(id));
    }

    public boolean companyExists(Company company) {
        return companyRepo.existsById(company.getId());
    }

    @Transactional
    public Company updateCompany(Company company) {
        return companyRepo.save(company);
    }
}

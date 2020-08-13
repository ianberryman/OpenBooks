package org.openbooks.openbooksapi.core.model;

import org.hibernate.Hibernate;
import org.openbooks.openbooksapi.core.repository.CompanyRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.EntityNotFoundException;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;

/**
 * Manages {@link Company} data and implements any business
 * logic required between controllers and repositories.
 */
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
    public Company createCompany(Company company) {
        return companyRepo.save(company);
    }

    @Transactional
    public Company updateCompany(Company company) {
        return companyRepo.save(company);
    }

    @Transactional
    public void deleteCompany(Long id) {
        try {
            companyRepo.deleteById(id);

        // remap exception to standard type
        } catch (EmptyResultDataAccessException e) {
            throw new EntityNotFoundException("Company with ID " + id + " not found");
        }
    }
}

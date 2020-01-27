package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.CompanyRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Optional;

@Service
public class CompanyService {

    @Autowired
    private CompanyRepository companyRepo;

    public Optional<Company> getCompanyById(Long id) {
        return companyRepo.findById(id);
    }
}

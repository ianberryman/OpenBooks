package org.openbooks.openbooksapi.core.repository;

import org.openbooks.openbooksapi.core.model.Company;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface CompanyRepository extends JpaRepository<Company, Long> {
}

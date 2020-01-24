package org.openbooks.openbooksapi.core.repository;

import org.openbooks.openbooksapi.core.model.Account;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface AccountRepository extends JpaRepository<Account, Long> {

	public List<Account> findByAccountNumber(String accountNumber);
}
